+++ 
draft = false
date = 2026-08-06T10:48:13+02:00
title = "Type Erasure in C++: Polymorphism without the hierarchy"
tags = ["C++", "type-erasure", "polymorphism", "virtual-dispatch", "templates"]
categories = ["C++"]
+++

## 1. Introduction

Every C++ engineer eventually runs into the same wall: you want to store a heterogeneous collection of objects — objects that behave similarly but share no common ancestor — and you don't want to force them into an inheritance hierarchy to make that work.

Maybe you're wrapping third-party types you don't control. Maybe you want to decouple your interface from your implementation without paying the long-term cost of a rigid `virtual` hierarchy. Maybe you just want a `std::function`-like "callable, any callable" without writing a template parameter into every signature that touches it.

This is the problem type erasure solves. It's not a language feature — there's no `type_erased` keyword — it's an idiom. A design pattern built on top of templates, virtual dispatch, and a bit of indirection, that lets you hide ("erase") the concrete type of an object behind a uniform, non-templated interface.

If you've read the earlier post on static vs. dynamic polymorphism, type erasure will feel familiar in its mechanics: it uses `virtual` dispatch internally. But the way it's _packaged_ — and the guarantees it gives the caller — are different enough to deserve their own treatment.

## 2. The Canonical Example: `std::function`

You've used type erasure already, whether you knew it or not. `std::function<R(Args...)>` is the standard library's flagship type-erased wrapper.

```cpp
std::function<int(int, int)> op;

op = [](int a, int b) { return a + b; };      // lambda, no captures
op = std::plus<int>{};                          // function object
op = &some_free_function;                        // function pointer

int result = op(3, 4);
```

Three completely unrelated types — a lambda closure, a functor, a function pointer — all fit into the same `std::function<int(int,int)>` variable. None of them derive from a common base class. `std::function` doesn't know or care what they actually are; it only knows they're "callable with `(int, int)` and return something convertible to `int`."

That's the essence of type erasure: **the concrete type is known at the point of construction, and forgotten immediately after.** From that point on, the wrapper interacts with the object exclusively through a fixed, type-independent interface.

## 3. Anatomy of the Mechanism

Every type-erased wrapper, `std::function` included, is built from the same three ingredients.

### 3.1 The Concept/Model idiom

This is the classic "external polymorphism" trick, sometimes attributed to Sean Parent's "Inheritance Is The Base Class of Evil" talk. You define a small abstract interface (the _Concept_) describing the operations you need:

```cpp
struct Concept {
    virtual ~Concept() = default;
    virtual void draw() const = 0;
    virtual std::unique_ptr<Concept> clone() const = 0;
};
```

Then, for _any_ concrete type `T`, you generate a template wrapper (the _Model_) that implements `Concept` by forwarding to `T`:

```cpp
template <typename T>
struct Model final : Concept {
    T value;
    explicit Model(T v) : value(std::move(v)) {}

    void draw() const override { value.draw(); }
    std::unique_ptr<Concept> clone() const override {
        return std::make_unique<Model<T>>(value);
    }
};
```

Notice: `T` never has to inherit from `Concept`. It just has to have a `draw()` method — the same duck-typing flexibility templates give you, but now packaged behind a virtual interface.

### 3.2 The non-templated wrapper

The user-facing class is _not_ a template. It holds a pointer (or, with SBO, inline storage) to a `Concept`, and its constructor is a template that instantiates the right `Model<T>`:

```cpp
class Drawable {
    std::unique_ptr<Concept> ptr_;
public:
    template <typename T>
    Drawable(T value) : ptr_(std::make_unique<Model<T>>(std::move(value))) {}

    Drawable(const Drawable& other) : ptr_(other.ptr_->clone()) {}
    Drawable(Drawable&&) noexcept = default;

    void draw() const { ptr_->draw(); }
};
```

This is the trick that makes type erasure feel almost magical: the _constructor_ is templated (so it accepts anything), but the _class itself_ is a fixed, ordinary, non-templated type. You can put `std::vector<Drawable>` in a header without a single template parameter leaking out.

### 3.3 Storage strategy: heap vs. SBO

The naive implementation above heap-allocates a `Model<T>` for every object, via `unique_ptr`. That's simple and correct, but it means every `Drawable` construction is a heap allocation — exactly the kind of overhead senior engineers building `std::function`-like utilities in hot paths care about.

The standard library avoids this for small objects using **Small Buffer Optimization (SBO)**: the wrapper reserves a fixed-size inline buffer (commonly 16–32 bytes, implementation-defined) and placement-constructs the `Model<T>` there if it fits, falling back to heap allocation only for larger types. This is why capturing a large `std::array` in a lambda passed to `std::function` can suddenly trigger heap allocations, while a lambda with one or two captured pointers stays purely on the stack.

## 4. Implementation From Scratch

Let's build a minimal, from-scratch type-erased wrapper for "anything drawable" — no inheritance required on the user's part.

```cpp
#include <memory>
#include <utility>

class Drawable {
    struct Concept {
        virtual ~Concept() = default;
        virtual void draw() const = 0;
        virtual std::unique_ptr<Concept> clone() const = 0;
    };

    template <typename T>
    struct Model final : Concept {
        T value;
        explicit Model(T v) : value(std::move(v)) {}
        void draw() const override { value.draw(); }
        std::unique_ptr<Concept> clone() const override {
            return std::make_unique<Model<T>>(value);
        }
    };

    std::unique_ptr<Concept> ptr_;

public:
    template <typename T>
    Drawable(T value) : ptr_(std::make_unique<Model<T>>(std::move(value))) {}

    Drawable(const Drawable& other) : ptr_(other.ptr_->clone()) {}
    Drawable(Drawable&&) noexcept = default;
    Drawable& operator=(Drawable other) { ptr_ = std::move(other.ptr_); return *this; }

    void draw() const { ptr_->draw(); }
};

// Usage: no shared base class anywhere
struct Circle   { void draw() const { /* ... */ } };
struct Square   { void draw() const { /* ... */ } };
struct TextBox  { void draw() const { /* ... */ } };

std::vector<Drawable> shapes;
shapes.emplace_back(Circle{});
shapes.emplace_back(Square{});
shapes.emplace_back(TextBox{});

for (const auto& s : shapes) s.draw();   // uniform call, three unrelated types
```

Note the `Concept`/`Model` classes live _inside_ `Drawable` as private nested types — the user of `Drawable` never sees them, never writes `virtual`, and never derives from anything. That's the entire point: the polymorphism is manufactured by the library, not imposed on the client's types.

`std::any` is essentially this same pattern, minus the `draw()` operation — its `Concept` interface only needs to support querying the type (`std::type_info`) and copying/destroying the held value.

## 5. Costs and Pitfalls

Type erasure isn't free, and its costs are easy to overlook because the syntax hides them so well.

**Indirection and cache behavior.** Every call through the type-erased interface is a virtual call — one indirect jump through a vtable — plus, if heap-allocated, a pointer chase to get to the actual data. In tight loops over large collections, this can matter far more than it would with a `std::vector<Circle>` of a single concrete type, where the compiler can inline freely and data stays contiguous.

**Allocation overhead.** Without SBO, every construction is a heap allocation, and every copy calls `clone()`, which allocates again. This is the single most common performance surprise: someone builds a `std::function`-based callback system, profiles it under load, and finds allocator contention they didn't expect.

**Loss of equality and hashing.** Two `Drawable` objects wrapping equal `Circle`s aren't comparable unless you explicitly add an `operator==` to the `Concept` interface — and even then, comparing across different concrete types (`Circle` vs. `Square`) needs a defined answer (usually: not equal, or a `dynamic_cast`-like check inside the model). The type information the erasure hid is exactly what equality needs, so you end up re-threading it back through the interface for exactly the operations you require, and no more.

**No downcasting by default.** Once you've erased the type, getting it back requires either:

- storing a `std::type_index` and doing a checked cast (this is precisely how `std::any` and `std::any_cast` work), or
- not getting it back at all, and designing the interface so you never need to.

Reaching for `any_cast` frequently is usually a sign that type erasure was the wrong tool — you erased information you actually still need.

**Value semantics complexity.** The `clone()` requirement means every erased type must be copyable if the wrapper itself needs to be copyable (as `std::function` requires all its targets to be `CopyConstructible`, which is a genuinely awkward historical wart — it's why move-only callables cause `std::function` construction to fail at compile time, and why C++23 added `std::move_only_function` to fix exactly this).

**Object lifetime and slicing-adjacent bugs.** Because the wrapper owns storage for the model, dangling references into an erased object are easy to create if you're not careful about whether the wrapper stores a value, a reference, or a pointer. `std::function` capturing a reference to a local that goes out of scope is a classic dangling-reference bug dressed up in type-erasure clothing.

## 6. When to Use It, and When Not To

Reach for type erasure when:

- You need a **uniform interface over an open, unbounded set of types** you don't control and can't force into a hierarchy (callables being the textbook case).
- The **set of operations you need is small and stable** (draw, call, compare — not "the entire public API of every possible type").
- You want to **avoid template bloat** in a public API — one non-templated `Drawable` in a header instead of `template <typename Shape> void render(const Shape&)` instantiated per call site across a large codebase.
- Copy/allocation cost is acceptable relative to the benefit of the abstraction — e.g. this is a configuration-time or setup-time object, not something constructed in a per-frame hot loop.

Prefer alternatives when:

- **The set of types is closed and known in advance** — `std::variant` + `std::visit` gives you the same "one type, many alternatives" ergonomics with no heap allocation, no vtable indirection, and exhaustiveness checking at compile time. If you can enumerate your alternatives, variant is almost always the better default in modern C++.
- **You control the type hierarchy and it's stable** — plain `virtual` dispatch with a real base class is simpler to reason about, and the vtable cost is identical, minus the extra indirection of the Concept/Model wrapper.
- **You need compile-time dispatch with zero runtime overhead** — CRTP or plain templates (static polymorphism) beat type erasure whenever the concrete type is known at the call site.
- **Performance-critical hot paths with many small objects** — the allocation and indirection costs of type erasure add up fast; profile before committing to this pattern in that context.

## 7. Summary

Type erasure gives you dynamic-polymorphism ergonomics — one interface, many unrelated concrete types — without forcing those types into a shared inheritance hierarchy. Under the hood it's nothing exotic: a hidden `virtual` Concept/Model pair, wrapped by a non-templated class whose constructor is a template. `std::function` and `std::any` are both instances of exactly this pattern.

The price is real: heap allocation (unless SBO applies), an extra layer of indirection on every call, lost equality/hashing/downcasting unless you explicitly rebuild it, and copy semantics that assume every erased type is copyable. Use it when the set of types is genuinely open-ended and the interface you need from them is small. When the type set is closed, reach for `std::variant` instead; when performance is critical and the type is known at compile time, reach for templates or CRTP instead. Type erasure is a specific tool for a specific shape of problem — not a default way to avoid deciding on a design.
