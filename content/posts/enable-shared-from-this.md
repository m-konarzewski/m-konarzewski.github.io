+++ 
draft = false
date = 2026-08-13T08:23:16+02:00
title = "std::enable_shared_from_this: Getting a safe shared_ptr to this"
tags = ["C++", "enable-shared-from-this", "shared-ptr", "weak-ptr"]
categories = ["C++"]
+++

## 1. Introduction

Here's a problem that looks trivial and isn't: you have an object managed by a `std::shared_ptr`, and from inside one of its own member functions, you need another `shared_ptr` pointing to the same object — to pass `this` to an async callback, register the object with an observer list, or hand out shared ownership to some other subsystem.

The obviously-wrong instinct is to just wrap `this`:

```cpp
class Connection {
public:
    void register_callback() {
        auto self = std::shared_ptr<Connection>(this);   // DO NOT DO THIS
        some_async_api(self);
    }
};
```

This compiles. It also creates a second, completely independent **control block** for the same object — `shared_ptr`'s reference count and deleter live in a control block, and `std::shared_ptr<Connection>(this)` allocates a _brand new one_, with a refcount of 1, with no knowledge whatsoever of the original `shared_ptr` that already owns this object with its own, separate refcount. The two control blocks race to be the one that eventually calls `delete` on the object — and both will, once each independently reaches zero. That's a double free, undefined behavior, and often a very confusing one to debug, because the crash happens long after the actual mistake was made.

`enable_shared_from_this` exists specifically to solve this: to give an object a way to correctly obtain a `shared_ptr` to itself, one that shares the _original_ control block instead of fabricating a new one.

## 2. The mechanism

You use it via CRTP — a pattern covered in more depth in the earlier post on the virtual constructor idiom, where CRTP eliminated `clone()` boilerplate; here it does something structurally different but syntactically identical:

```cpp
class Connection : public std::enable_shared_from_this<Connection> {
public:
    void register_callback() {
        auto self = shared_from_this();   // correct: shares the existing control block
        some_async_api(self);
    }
};
```

`std::enable_shared_from_this<Connection>` is a CRTP base — `Connection` inherits from a template instantiated with itself as the argument, which is what lets the base class's `shared_from_this()` return `shared_ptr<Connection>` (via a covariant-return-style cast internally) rather than some more generic type.

Under the hood, `enable_shared_from_this<T>` holds exactly one piece of state: a `mutable std::weak_ptr<T> weak_this_;`. A `weak_ptr`, unlike a `shared_ptr`, doesn't contribute to the reference count — it observes an existing control block without owning a share of it, which is exactly the property needed here: this member needs to _reference_ the control block that will eventually own the object, without itself keeping the object alive or creating a new ownership relationship.

The genuinely clever part is _when_ `weak_this_` gets populated, since the object doesn't know at construction time whether it will ever be managed by a `shared_ptr` at all. The standard specifies a hook: whenever a `shared_ptr<T>` is constructed from a raw pointer (or via `std::make_shared<T>`), and `T` is derived from `enable_shared_from_this<T>`, the `shared_ptr` constructor detects this (via a private, standard-mandated mechanism, often referred to informally as the `__enable_shared_from_this` hook) and quietly assigns `weak_this_` to observe the newly-created control block — entirely before your code gets a chance to call any member function on the object.

```cpp
auto conn = std::make_shared<Connection>();
// at this point, conn's internal weak_this_ has already been silently
// wired up to observe conn's control block — no explicit step needed
```

## 3. `shared_from_this()` step by step

Calling `shared_from_this()` does something conceptually simple: it locks the internal `weak_ptr`.

```cpp
std::shared_ptr<T> enable_shared_from_this<T>::shared_from_this() {
    return std::shared_ptr<T>(weak_this_);   // roughly: weak_this_.lock(), with a throw on failure
}
```

Because `weak_this_` observes the _original_ control block — the one created when the object was first wrapped in a `shared_ptr` — the `shared_ptr` returned by `shared_from_this()` increments that same, original reference count. It doesn't create a new one. Every `shared_ptr` obtained this way, and the original `shared_ptr` the object was constructed through, all agree on when the object should actually be destroyed, because they're all sharing one refcount and one deleter, instead of racing between two independent ones as in Section 1's broken example.

## 4. The critical pitfall: The object must already be `shared_ptr`-managed

`shared_from_this()`'s correctness depends entirely on `weak_this_` having been wired up by that constructor hook — which only happens if the object was, at some point, wrapped in a `shared_ptr`. If it wasn't — a stack-allocated object, or one created with a bare `new` that's never handed to a `shared_ptr` — `weak_this_` is empty, and calling `shared_from_this()` on it is a direct path to failure:

```cpp
void broken() {
    Connection c;                    // stack-allocated: never managed by any shared_ptr
    c.register_callback();           // calls shared_from_this() internally -> throws std::bad_weak_ptr
}

void also_broken() {
    Connection* c = new Connection;  // heap-allocated, but still never wrapped in a shared_ptr
    c->register_callback();          // same problem: weak_this_ was never populated
}
```

Since C++17, this specific failure mode (an empty `weak_this_`) reliably throws `std::bad_weak_ptr` rather than invoking undefined behavior — the standard tightened this exact guarantee in C++17, where earlier it was looser and implementation-defined. But "throws instead of corrupting memory" is a low bar, not a design goal — a `std::bad_weak_ptr` exception thrown from deep inside an async callback registration path, at runtime, in exactly the code path that only gets exercised when something upstream forgot to `make_shared` the object, is still a bug you'd much rather catch earlier. The core rule is simple to state and easy to violate in practice, especially across a large codebase: **never call `shared_from_this()` unless you can be certain, structurally, that the object is currently owned by at least one `shared_ptr`.**

## 5. Typical applications

**Asynchronous callback lifetime extension.** This is by far the most common real-world use. In event-driven or async I/O frameworks like Boost.Asio, an object needs to guarantee it stays alive for the duration of an in-flight asynchronous operation, even if every other `shared_ptr` to it goes out of scope in the meantime:

```cpp
class Session : public std::enable_shared_from_this<Session> {
public:
    void start_read() {
        auto self = shared_from_this();   // extends this object's lifetime
        socket_.async_read_some(buffer_,
            [self](std::error_code ec, std::size_t n) {
                self->handle_read(ec, n);   // 'self' keeps the Session alive
                                             // until this callback actually runs
            });
    }
};
```

Capturing `self` (not `this`) in the lambda means the callback itself holds a genuine share of ownership. Even if whoever originally created the `Session` drops their `shared_ptr` before the read completes, the object stays alive — because the lambda's captured `self` is still keeping the refcount above zero — right up until the callback runs and `self` itself is destroyed.

**Self-registration with an observer or registry.** An object that needs to hand a `shared_ptr` to itself to some external registry or observer list — so that registry can later notify or look up the object — needs exactly this mechanism rather than passing `this` as a raw pointer, if the registry is expected to participate in the object's shared ownership rather than just observe it non-owningly.

## 6. `weak_from_this()` (C++17)

C++17 also added `weak_from_this()`, returning a `std::weak_ptr<T>` instead of a `shared_ptr<T>`. It's the safer tool when you're not certain, at the call site, whether the object is currently `shared_ptr`-managed — because `weak_from_this()` doesn't throw in the unmanaged case; it simply returns an empty `weak_ptr`, which `.lock()` then turns into an empty `shared_ptr` rather than an exception:

```cpp
void maybe_register() {
    if (auto self = weak_from_this().lock()) {
        // self is non-null: this object genuinely is managed by a shared_ptr right now
        registry.add(self);
    } else {
        // gracefully handle the case where it isn't, instead of catching bad_weak_ptr
    }
}
```

This is generally the better default whenever the calling context can't structurally guarantee `shared_ptr` ownership — library code called from contexts you don't fully control, for instance — since it turns a potential exception into an ordinary, checkable condition.

## 7. Interaction with inheritance

Multiple inheritance can create a genuine ambiguity: if two separate base classes each independently inherit from `enable_shared_from_this<Base1>` and `enable_shared_from_this<Base2>`, and a derived class inherits from both, the derived class ends up with two distinct `weak_this_` members and two distinct `shared_from_this()` overloads — an ambiguous call the compiler will reject outright.

```cpp
struct Base1 : std::enable_shared_from_this<Base1> { virtual ~Base1() = default; };
struct Base2 : std::enable_shared_from_this<Base2> { virtual ~Base2() = default; };

struct Derived : Base1, Base2 {
    void use() {
        // shared_from_this();   // ambiguous: Base1's or Base2's?
        auto self = Base1::shared_from_this();   // must disambiguate explicitly
    }
};
```

The idiomatic fix, when you control the design, is to have only _one_ class in the hierarchy inherit from `enable_shared_from_this`, typically the most-derived common base that actually needs the capability, and let the rest of the hierarchy simply not duplicate it. If the diamond genuinely can't be avoided, explicit qualification (`Base1::shared_from_this()`) resolves the ambiguity at each call site, same as any other multiple-inheritance name clash — but it's worth treating the ambiguity itself as a signal to reconsider whether both bases actually need independent `enable_shared_from_this` at all.

## 8. Summary

`enable_shared_from_this` solves a narrow but real problem: safely obtaining a `shared_ptr` to `this` from inside a member function, without fabricating a second, independent control block that leads to a double free. It works via CRTP, a hidden `weak_ptr` member silently wired up by a special hook inside `shared_ptr`'s own constructor whenever the object is first wrapped, and a `shared_from_this()` that locks that `weak_ptr` to hand back a `shared_ptr` sharing the original control block. Its sharpest edge is the requirement that the object already be `shared_ptr`-managed at the time of the call — violating that throws `std::bad_weak_ptr` since C++17, and `weak_from_this()` exists specifically to sidestep that risk when the calling context can't guarantee ownership structurally. The pattern is most visible in asynchronous frameworks, where an object needs to keep itself alive for the duration of a callback it's registering — a real, common need that `shared_ptr<T>(this)` looks like it solves and very much does not.
