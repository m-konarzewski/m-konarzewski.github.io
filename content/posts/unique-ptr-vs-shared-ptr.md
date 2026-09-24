+++ 
draft = false
date = 2026-09-24T10:05:43+02:00
title = "unique_ptr vs shared_ptr practical differences"
tags = ["unique_ptr", "shared_ptr", "pimpl"]
categories = ["C++"]
+++

# Why `shared_ptr` can save you from a non-virtual destructor (and `unique_ptr` won't)

Every C++ engineer has internalized the rule: if a class is meant to be used polymorphically, its destructor must be `virtual`. Skip that, and destroying a derived object through a base pointer is undefined behavior.

What's less well known is that **your two most common smart pointers don't fail the same way**. `unique_ptr` walks straight into the UB. `shared_ptr`, constructed via `make_shared`, quietly avoids it — for a reason that has nothing to do with `A` having a virtual destructor and everything to do with how each smart pointer decides _what to delete_.

## The setup

```cpp
struct A {
    A() { std::cout << "A" << std::endl; }
    ~A() { std::cout << "~A" << std::endl; }
};

struct B : A {
    B() { std::cout << "B" << std::endl; }
    ~B() { std::cout << "~B" << std::endl; }
};
```

Note: `~A()` is **not** virtual. Now consider two ways of owning a `B` through a pointer to `A`:

```cpp
std::unique_ptr<A> ua = std::make_unique<B>();
std::shared_ptr<A> sa = std::make_shared<B>();
```

## `unique_ptr`: the deleter is baked into the type

`unique_ptr<A>`'s deleter is `std::default_delete<A>` — fixed at compile time by the template parameter `A`. When `ua` goes out of scope, it effectively calls:

```cpp
delete static_cast<A*>(ptr);
```

Since `~A()` isn't virtual, this is a non-virtual call resolved on the _static_ type. The dynamic type (`B`) is irrelevant to the compiler at this call site. `~B()` never runs. Per [expr.delete], deleting through a pointer to a base class with a non-virtual destructor when the dynamic type differs from the static type is undefined behavior — not just "ugly," but formally unspecified. In practice, most compilers will simply skip `~B()`:

```
A
B
~A
```

## `shared_ptr`: the deleter remembers the real type

`shared_ptr<A>` looks like it should have the exact same problem — but it doesn't. The reason lives in the control block.

When you call `make_shared<B>()`, the control block's deleter is captured **at construction time**, based on the actual pointer type being managed (`B*`), not on `shared_ptr`'s template parameter (`A`). The deleter is type-erased and stored once, up front — so no matter what `shared_ptr<A>` you later assign it into, destruction still calls through the original `B*`:

```cpp
delete static_cast<B*>(ptr); // the type captured at construction
```

The result is correct, in order:

```
A
B
~B
~A
```

## The catch: a custom deleter breaks the safety net

The "safety" of `shared_ptr` isn't some inherent property of the type — it comes entirely from how the default deleter is generated. `shared_ptr` has a constructor that lets you supply your own deleter:

```cpp
template<class Y, class Deleter>
shared_ptr(Y* ptr, Deleter d);
```

The critical detail is that `Y` is deduced from the pointer expression you actually pass in — **not** from the `shared_ptr<A>` you're constructing. But `Y` deduction isn't actually what decides the outcome here — what matters is the parameter type the deleter itself declares. Whatever `Y` gets deduced as, the deleter is invoked with an implicit conversion to its own parameter type, and `delete` inside the deleter acts on _that_ static type:

```cpp
std::shared_ptr<A> sa(
    new B(),                    // Y deduced as B — the pointer expression's real type
    [](A* p) { delete p; }      // but the deleter's parameter is A* — delete through A*: ~A() is non-virtual, ~B() is skipped
);
```

Output:

```
A
B
~A
```

`~B()` never runs, even though `Y = B` here — the `new B()` expression was never cast to anything. `Y` only affects what pointer type gets stored internally; it plays no role in what happens when the deleter runs. What decides that is entirely the deleter's own signature.

Compare this to a deleter that takes `B*` instead:

```cpp
std::shared_ptr<A> sb(
    new B(),
    [](B* p) { delete p; }      // deleter's parameter is B* -> delete through B*: ~B() runs, then ~A()
);
```

Output:

```
A
B
~B
~A
```

Same `shared_ptr<A>` on the left-hand side in both cases, and the same `new B()` on the right — the only difference is the parameter type the deleter itself declares. The type deduced for `Y` never enters into it.

This is exactly what `make_shared<B>()` does under the hood: it generates a deleter whose parameter type is `B*`, matching the type it constructed, and binds it for you. It isn't magic — it's just that the library gets the deleter's signature right on your behalf. The moment you supply your own deleter, that responsibility transfers to you, and a careless choice of parameter type on that deleter — declaring it to take `A*` instead of `B*` — silently reintroduces the exact bug this post started with, regardless of how the pointer itself was obtained or cast.

## A related asymmetry: incomplete types and pImpl

The same underlying fact — _when_ each smart pointer needs to know the concrete type it's managing — shows up again in a completely different context: the pImpl idiom, where a class holds a pointer to a type that's only forward-declared.

```cpp
// widget.h
class Impl; // incomplete — only forward-declared

class Widget {
public:
    Widget();
    ~Widget();
private:
    std::unique_ptr<Impl> pImplUnique;
    std::shared_ptr<Impl> pImplShared;
};
```

### Construction: `shared_ptr`'s own constructor checks; `unique_ptr`'s doesn't

The libstdc++ and libc++ headers show exactly where each smart pointer draws the line. `shared_ptr`'s converting constructor from a raw pointer contains the check directly inside itself:

```cpp
// bits/shared_ptr_base.h, inside __shared_ptr(_Yp* __p)
static_assert( sizeof(_Yp) > 0, "incomplete type" );
```

So `shared_ptr<Impl>(raw)` fails to compile the moment it's written, wherever `Impl` is incomplete — the constructor itself refuses to run. `unique_ptr`'s constructor from a raw pointer has no equivalent check; it's a trivial `noexcept` store of the pointer, and calling it in isolation — as a standalone expression, with nothing else around it — genuinely compiles regardless of `Impl`'s completeness.

Here's that isolation made concrete. The trick is to make sure the smart pointer itself never goes out of scope in this translation unit — heap-allocate the _handle_, not the pointee, and never destroy it here:

```cpp
#include <memory>
class Impl; // incomplete throughout this file

Impl* getRaw();

// Heap-allocate the smart pointer itself and hand back a pointer to it.
// It's never destroyed in this translation unit, so its own destructor
// is never instantiated here — only the constructor matters.

std::unique_ptr<Impl>* makeHandleUnique() {
    return new std::unique_ptr<Impl>(getRaw());   // compiles
}

std::shared_ptr<Impl>* makeHandleShared() {
    return new std::shared_ptr<Impl>(getRaw());   // fails to compile
}
```

`makeHandleUnique` compiles cleanly, on both GCC and Clang. `makeHandleShared` doesn't — same `static_assert` as before, now firing from inside a genuine, running piece of code rather than just a header excerpt:

```
error: invalid application of 'sizeof' to incomplete type 'Impl'
  ...instantiation of 'shared_ptr<Impl>::shared_ptr(_Yp*)' requested here
  return new std::shared_ptr<Impl>(getRaw());
```

This is about as isolated as the distinction gets: no member initializer, no implicit exception-cleanup path, nothing but the constructor call itself. It confirms the claim precisely — and also shows how narrow it is. The moment either smart pointer needs to be destroyed in a translation unit where `Impl` is incomplete, `unique_ptr` loses this advantage entirely. That's easy to demonstrate too: even calling `.release()` right before the `unique_ptr` goes out of scope doesn't help, because the destructor still runs on the (now-null) handle, and the compiler still needs it to be valid:

```cpp
void demo() {
    std::unique_ptr<Impl> p(getRaw());
    p.release();     // doesn't matter
}   // <- ~unique_ptr<Impl>() is still required here, and still fails
```

That said, this narrow advantage is easy to lose the moment the constructor call isn't standalone anymore. Consider it written exactly as a `Widget` member initializer, even with an explicit `nullptr` and nothing else going on:

```cpp
// widget.h
class Impl;

class Widget {
public:
    Widget() : pImplUnique{nullptr} {}   // still fails — see below
    ~Widget();
private:
    std::unique_ptr<Impl> pImplUnique;
};
```

This fails to compile (GCC and Clang agree), and the error traces to the same place as the destruction example further down: `~unique_ptr<Impl>()` gets instantiated because of `Widget()`'s implicit member-cleanup path, exactly as described in the next section. So "the constructor has no completeness check" is true about `unique_ptr`'s own constructor in isolation — but as soon as it's embedded in a class's own constructor (which is the entire point of pImpl), it collapses into the same failure as destruction. The two rows in the table below are, in realistic code, really one and the same failure for `unique_ptr` — the isolated success case essentially never survives being used for anything.

### Destruction: even an empty `unique_ptr<Impl>` drags the type in

Here's the cleanest possible demonstration, stripped of every distraction — no `new`, no raw pointer at all, just a default-initialized member. Note this uses a _different_ `shared_ptr` constructor than the one discussed above: the argument-less default constructor `shared_ptr()`, not `shared_ptr(Y* ptr)`. There's no `Y` to deduce and no raw pointer involved, so the completeness check from the construction section simply doesn't apply here — this isn't a contradiction of it, just a different code path:

```cpp
// widget.h
class Impl;

class Widget {
public:
    Widget() : pImplUnique{} {}   // pImplUnique is just null — nothing Impl-related happens here
    ~Widget();
private:
    std::unique_ptr<Impl> pImplUnique;
};
```

```cpp
// widget.cpp
#include "widget.h"
class Impl {};
Widget::~Widget() {}
```

```cpp
// main.cpp — never sees a complete Impl
#include "widget.h"
int main() { Widget w; }
```

This fails to compile (confirmed on both GCC and Clang — not a single-compiler quirk), and the error points at the constructor itself:

```
error: invalid application of 'sizeof' to incomplete type 'Impl'
  ...instantiation of 'unique_ptr<Impl>::~unique_ptr' requested here
widget.h:6: Widget() : pImplUnique{} {}
```

`pImplUnique` never holds a real `Impl*` here — it's `nullptr` the whole time. Yet the compiler still fails, because it must generate an implicit cleanup path for `Widget()`'s member-initializer list: if a _later_ member's initialization were to throw, already-initialized members need to be destroyed. That requires `~unique_ptr<Impl>()` to be valid **at the point the constructor is defined** — the header — regardless of whether anything could actually throw, and regardless of whether the pointer is null. Since `Widget()` is defined inline, this check re-fires in every translation unit that constructs a `Widget`, including `main.cpp`.

The equivalent `shared_ptr` version, same structure:

```cpp
// widget.h
class Impl;

class Widget {
public:
    Widget() : pImplShared{} {}   // pImplShared is just null too
    ~Widget();
private:
    std::shared_ptr<Impl> pImplShared;
};
```

```cpp
// widget.cpp
#include "widget.h"
class Impl {};
Widget::~Widget() {}
```

```cpp
// main.cpp — never sees a complete Impl
#include "widget.h"
int main() { Widget w; }
```

This compiles cleanly, on both GCC and Clang. A default-constructed `shared_ptr<Impl>` has no control block at all — nothing was ever allocated, so there's no deleter to type-erase and nothing that needs `Impl` to be complete, whether that destruction happens implicitly (exception cleanup) or explicitly (scope exit).

### The pattern, side by side

|                                                                                                | `pImplUnique` (`unique_ptr<Impl>`)                                                                                               | `pImplShared` (`shared_ptr<Impl>`)                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Construct from a raw `Impl*` as a **standalone expression**, where `Impl` is incomplete        | OK — the constructor itself has no completeness check                                                                            | **Fails** — `static_assert` lives directly inside the constructor                                                                                      |
| Used as a **class member** — either constructed there or destroyed, where `Impl` is incomplete | **Fails**, either way — the enclosing constructor's implicit cleanup path, or the destructor itself, needs `~unique_ptr<Impl>()` | OK, either way — an empty/default `shared_ptr` has no deleter to call; a populated one already captured its deleter earlier, where `Impl` was complete |

This is the mirror image of the deleter behavior from the earlier section, but sharper: `shared_ptr`'s converting constructor from a raw pointer rejects incompleteness immediately and is then done with the question forever — but that's a distinct code path from the default constructor, which never needed `Impl` in the first place. `unique_ptr` accepts incompleteness at construction — but that reprieve is narrower than it looks, because almost any realistic use of the member (including the enclosing class's own constructor, not just its destructor) ends up needing `~unique_ptr<Impl>()` anyway. That's why the conventional pImpl advice with `unique_ptr` isn't just "define the destructor out-of-line" — it's "define _both_ the constructor and the destructor of the owning class in the `.cpp` file," so that every code path touching `pImplUnique`'s destructor sees a complete `Impl`.

## `unique_ptr` isn't tied to raw pointers — `shared_ptr` is

There's a structural reason `unique_ptr` can be pushed into places `shared_ptr` can't follow, and it has nothing to do with destructors: **`unique_ptr` doesn't necessarily store a `T*`**. It stores whatever type its deleter tells it to.

### Where the pointer type actually comes from

`unique_ptr`'s internals pick their storage type like this:

```cpp
using pointer = typename std::remove_reference_t<Deleter>::pointer; // if Deleter::pointer exists
// otherwise:
using pointer = T*; // fallback
```

If the `Deleter` you supply has a nested `pointer` typedef, `unique_ptr` uses _that_ type — for storage, for `get()`, for `operator->`/`operator*` — instead of a plain `T*`. `shared_ptr` has no equivalent hook: its control block type-erases the deleter, but the managed value itself is always a raw `T*` under the hood, which is baked into how the control block, aliasing constructor, `weak_ptr`, and `enable_shared_from_this` all interoperate.

Any type satisfying **`NullablePointer`** (comparable to `nullptr`, default-constructible into a "null" state, copyable/movable, equality-comparable) is eligible here — this is called a _fancy pointer_: something that behaves like a pointer without necessarily being a raw address.

### A concrete use case: shared memory

A plain `T*` is a virtual address, and virtual addresses aren't portable across processes — a shared-memory segment is typically mapped at a _different_ base address in each process attached to it. An absolute pointer written by process A into that segment is meaningless read back in process B.

The fix is to store an **offset from the start of the segment** instead of an absolute address — the same offset is valid in every process, since each computes it relative to its own mapping's base. `boost::interprocess::offset_ptr<T>` implements exactly this: it overloads `operator*`, `operator->`, comparisons, and so on, but internally holds an offset, not an address.

```cpp
#include <boost/interprocess/offset_ptr.hpp>

struct SharedMemDeleter {
    using pointer = boost::interprocess::offset_ptr<Widget>; // the hook

    void operator()(pointer p) const {
        p->~Widget();
        // ... return the slot to the shared-memory allocator ...
    }
};

std::unique_ptr<Widget, SharedMemDeleter> p(/* an offset_ptr<Widget> into shared memory */);
```

Because `SharedMemDeleter::pointer` is defined, `unique_ptr<Widget, SharedMemDeleter>` stores an `offset_ptr<Widget>` instead of a `Widget*`. Every part of `unique_ptr`'s contract — RAII, move-only ownership, invoking the deleter on destruction — still works identically; only the representation of "where the object is" changes underneath.

`shared_ptr` can't be retargeted this way: its extra machinery (control block, reference counting, aliasing) is written in terms of a real `T*`, so it trades away this flexibility for the features that require a raw pointer underneath.
