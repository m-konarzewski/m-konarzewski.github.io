+++ 
draft = false
date = 2026-08-07T07:54:44+02:00
title = "Virtual constructor idiom in C++"
tags = ["C++", "virtual-constructor", "clone-idiom", "covariant-return-type"]
categories = ["C++"]
+++

## 1. Introduction

"Virtual constructor" is one of those C++ terms that trips people up the first time they hear it, because it sounds like it should be a language feature — and it isn't. There is no `virtual` keyword you can attach to a constructor. The standard forbids it outright.

The reason is structural, not arbitrary. Virtual dispatch works by resolving a call through an object's vtable pointer, and that vtable pointer is only fully set up _once construction has run_ — specifically, once the constructor of the most-derived class in the hierarchy has executed. During construction of a base subobject, the vtable pointer reflects the type currently being constructed, not the final derived type. Calling a virtual function from inside a base constructor famously dispatches to the base's implementation, never to an override in a not-yet-constructed derived class — a fact you may recall from earlier puzzles on this blog about virtual dispatch in constructors and destructors. A "virtual constructor" would require dispatching _before_ the object — and its vtable — fully exists. That's a contradiction, not just an implementation inconvenience.

So "virtual constructor" isn't a language feature. It's the name of a design idiom — a technique for getting constructor-like behavior (creating a new object) that is nonetheless dispatched polymorphically at runtime, based on an object's dynamic type.

## 2. The Problem It Solves

Consider a polymorphic hierarchy accessed only through a base pointer or reference:

```cpp
struct Shape {
    virtual ~Shape() = default;
    virtual void draw() const = 0;
};

struct Circle : Shape { void draw() const override; /* ... */ };
struct Square : Shape { void draw() const override; /* ... */ };
```

Now suppose you're holding a `Shape*` and you want to create a _new_ object with the same dynamic type and the same state as the one it points to — without knowing, at the call site, whether it's actually a `Circle`, a `Square`, or some type added six months from now in a different translation unit.

```cpp
void duplicate(const Shape& s) {
    Shape* copy = ???;   // needs to be a new Circle if s is a Circle,
                          // a new Square if s is a Square
}
```

You can't call `new Shape(s)` — `Shape` is abstract, and even if it weren't, that would slice the object down to its base part, discarding everything the derived class added. You can't `switch` on a type tag either, unless you're willing to touch this function every time a new shape is added — which defeats the entire purpose of polymorphism.

What you actually want is a _constructor selected by the object's runtime type_. Hence: virtual constructor.

## 3. Implementation: The Clone Idiom

The standard implementation is the **clone idiom**: a virtual member function, conventionally named `clone()`, that each derived class overrides to construct a new instance of itself.

```cpp
struct Shape {
    virtual ~Shape() = default;
    virtual void draw() const = 0;
    virtual std::unique_ptr<Shape> clone() const = 0;
};

struct Circle : Shape {
    void draw() const override { /* ... */ }
    std::unique_ptr<Shape> clone() const override {
        return std::make_unique<Circle>(*this);
    }
};

struct Square : Shape {
    void draw() const override { /* ... */ }
    std::unique_ptr<Shape> clone() const override {
        return std::make_unique<Square>(*this);
    }
};
```

Now `duplicate` works without ever knowing the concrete type:

```cpp
std::unique_ptr<Shape> duplicate(const Shape& s) {
    return s.clone();
}
```

`clone()` itself does the "real" construction with `make_unique<Circle>(*this)`, using the compiler-generated (or user-defined) copy constructor of `Circle`. The virtual dispatch happens on `clone()` — an ordinary member function, fully legal to be `virtual` — and _inside_ that already-dispatched call, an ordinary, perfectly legal, non-virtual constructor runs on a fully-known concrete type. That's the trick: you don't make the constructor virtual, you make the _function that calls the constructor_ virtual.

## 4. Implementation Variants

### 4.1 Covariant return types

You may have noticed both overrides above return `std::unique_ptr<Shape>`, even though `Circle::clone()` clearly knows it's making a `Circle`. C++ allows overriding virtual functions to return a more derived pointer or reference type than the base declares — this is called a **covariant return type**:

```cpp
struct Shape {
    virtual std::unique_ptr<Shape> clone() const = 0;
};

struct Circle : Shape {
    std::unique_ptr<Circle> clone() const override {   // covariant: Circle, not Shape
        return std::make_unique<Circle>(*this);
    }
};
```

This is more than cosmetic. If you're holding a `Circle&` directly (not through `Shape&`), calling `.clone()` on it gives you back a `unique_ptr<Circle>`, not a `unique_ptr<Shape>` — no cast required to get at `Circle`-specific members. Covariance is only permitted for pointer/reference return types, not values, and only when the derived return type is unambiguously and publicly derived from the base return type — which `unique_ptr<Circle>` from `unique_ptr<Shape>` technically is _not_, since `unique_ptr<Circle>` doesn't inherit from `unique_ptr<Shape>`. In practice, this means raw pointer covariance works out of the box (`Circle*` from `Shape*`), but smart-pointer covariance needs either raw pointers internally (with ownership documented by convention) or a small amount of extra plumbing — commonly solved with CRTP, below.

### 4.2 CRTP to eliminate boilerplate

Every derived class in this idiom writes an almost identical `clone()` override — only the concrete type name changes. That repetition is exactly what CRTP (Curiously Recurring Template Pattern) is good at eliminating:

```cpp
template <typename Derived, typename Base>
struct ClonableBase : Base {
    using Base::Base;
    std::unique_ptr<Base> clone() const override {
        return std::make_unique<Derived>(static_cast<const Derived&>(*this));
    }
};

struct Circle : ClonableBase<Circle, Shape> {
    void draw() const override { /* ... */ }
};

struct Square : ClonableBase<Square, Shape> {
    void draw() const override { /* ... */ }
};
```

Each derived class now writes zero clone-related code — `ClonableBase` generates a correct `clone()` for each `Derived` automatically, using the CRTP pattern to know, at compile time, exactly which concrete type it's constructing. This is the same technique covered in the earlier CRTP discussion on this blog, applied specifically to eliminate virtual-constructor boilerplate — a very common real-world use of CRTP alongside a `virtual` hierarchy, not instead of one.

## 5. "Virtual Constructor" as a Generalization

`clone()` — a virtual _copy_ constructor — is the most common form, but the idiom generalizes further. The broader idea is: **any polymorphic creation of a new object, dispatched at runtime, without the caller knowing the concrete type.**

This connects directly to two classic GoF patterns:

- **Prototype pattern** — `clone()` _is_ the Prototype pattern. You keep a registry of pre-configured "prototype" objects and create new instances by cloning a prototype rather than calling `new` on a hardcoded type name.
- **Factory Method pattern** — a virtual `create()` (as opposed to `clone()`) that builds a _default-constructed_ new instance of the same dynamic type, rather than a copy of `*this`:

```cpp
struct Shape {
    virtual std::unique_ptr<Shape> create() const = 0;  // "default" virtual constructor
};

struct Circle : Shape {
    std::unique_ptr<Shape> create() const override {
        return std::make_unique<Circle>();   // fresh, default-constructed Circle
    }
};
```

Both `clone()` and `create()` answer the same underlying question — "construct me one of whatever type this object actually is" — just with different initialization semantics (copy vs. default).

## 6. Practical Applications

**Polymorphic containers.** `std::vector<std::unique_ptr<Shape>>` is a common pattern discussed on this blog before, but copying such a container is nontrivial — `vector`'s copy constructor can't just copy `unique_ptr`s (they're move-only), and even if it could, a shallow pointer copy would share ownership incorrectly. `clone()` is exactly what you need to implement a correct deep-copying container of polymorphic objects:

```cpp
std::vector<std::unique_ptr<Shape>> deep_copy(const std::vector<std::unique_ptr<Shape>>& src) {
    std::vector<std::unique_ptr<Shape>> result;
    result.reserve(src.size());
    for (const auto& s : src) result.push_back(s->clone());
    return result;
}
```

**Deep-copying hierarchies generally.** Any tree- or graph-shaped structure of polymorphic nodes (AST nodes, scene graphs, document object models) needs exactly this to implement a correct, type-preserving deep copy.

**Serialization/deserialization.** A common pattern pairs a type tag on disk with a registry of `create()` functions (or `clone()`-able prototypes) keyed by that tag, letting a deserializer reconstruct the correct concrete type from data alone — without a giant `if/else` chain of `if (tag == "circle") return new Circle(...)` scattered through the codebase.

**Prototype-based editors and games.** Level editors, GUI builders, and games with "spawn a copy of this configured object" workflows (place a pre-tuned enemy template, duplicate a configured UI widget) are textbook Prototype-pattern use cases — `clone()` is the mechanism.

## 7. Pitfalls

**Object slicing when clone() is forgotten or misused.** If a derived class fails to override `clone()`, and the base's `clone()` is pure virtual, that's a compile error — safe. But if someone weakens the base to provide a non-pure default implementation "for convenience," a forgotten override silently returns an object sliced down to the base type, with all derived-specific state and behavior lost. This is a much nastier bug than a compile error, because it fails silently at runtime instead of loudly at compile time — prefer pure virtual `clone()` specifically to force every derived class to opt in explicitly.

**Every new derived class must remember to implement it.** This is the general maintenance cost of any pure virtual function in a growing hierarchy, but it's worth calling out here because `clone()` is easy to forget precisely because "copying" already looks like it's handled by the implicitly-generated copy constructor — right up until you access the object polymorphically and discover it isn't.

**Allocation cost on every clone.** Just as with type erasure, `clone()` implies a heap allocation (via `make_unique`) on every call. In tight loops — say, cloning thousands of particles per frame in a game — this can become a real bottleneck, and pooling or reserving storage ahead of time may be necessary.

**Copy constructor correctness is inherited, not automatic.** `clone()` is only as correct as the copy constructor it calls. If a derived class holds owning raw pointers and relies on the compiler-generated copy constructor, `clone()` will happily compile and silently produce shallow, double-freeing copies. The virtual constructor idiom doesn't fix incorrect copy semantics — it just dispatches to whatever copy constructor already exists, correct or not.

## 8. Summary

C++ doesn't allow virtual constructors as a language feature, for a good structural reason: a vtable can't dispatch to a type that doesn't exist yet. The virtual constructor idiom works around this by making an ordinary virtual member function — `clone()`, or more generally `create()` — responsible for constructing the new object, letting virtual dispatch pick the right _override_, which then calls an entirely ordinary, non-virtual constructor of a fully-known concrete type. Covariant return types sharpen the interface for direct derived-type access, and CRTP eliminates the repetitive boilerplate of writing near-identical `clone()` overrides by hand. The idiom underlies the Prototype and Factory Method design patterns and is the standard, correct way to deep-copy or default-construct objects through polymorphic containers and hierarchies — as long as you remember that its correctness rides entirely on the correctness of the copy constructor it calls underneath.
