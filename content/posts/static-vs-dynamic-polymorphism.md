+++ 
draft = false
date = 2026-07-27T11:14:18+02:00
title = "Static vs. dynamic polymorphism in C++: complete guide"
tags = ["C++20", "Polymorphism", "Templates", "CRTP", "Type erasure"]
categories = ["C++"]
+++

## Introduction

"Polymorphism" is one of those words that, in C++, can mean surprisingly different things depending on who you ask — some will immediately think of `virtual` and vtables, others of templates and CRTP, others of function overloading. All of these answers are correct, which is part of the problem: C++ is one of the few mainstream languages that offers two fully-fledged, orthogonal polymorphism mechanisms — one resolved at compile time, the other at run time — plus several hybrids that try to get the best of both worlds.

This article has one goal: to give you a solid, organized mental model of this topic. We won't start with "virtual is slow, templates are fast" — that's true, but it's the least interesting part of the story. The real dividing line between static and dynamic polymorphism doesn't run along the performance axis; it runs along a much more fundamental one: **whether the set of types you're working with is known at compile time, or can grow at run time**. Everything else — performance, binary size, compiler error readability, ABI — is a consequence of that one choice.

The article is split into four parts. First, we build the conceptual foundations — what polymorphism actually is and how both mechanisms work under the hood. Then we move to design consequences — when each choice makes sense. Finally, we cover concrete patterns and tools from modern C++ that combine both approaches: CRTP, `std::variant`, type erasure, and concepts.

---

## Part 1: Foundations

### 1. What polymorphism actually is

Before diving into C++, it's worth stepping back and asking what "polymorphism" means in general — independent of any specific language. The classic taxonomy proposed by Luca Cardelli and Peter Wegner in 1985 splits polymorphism into three categories:

- **Ad-hoc polymorphism (overloading)** — the same name refers to different, unrelated implementations, selected based on argument types. `operator+` for `int` and for `std::string` are two entirely different operations that happen to share a name.
- **Parametric polymorphism (genericity)** — a single implementation works across a whole family of types, without knowing anything about their specific nature. `std::vector<T>` doesn't know and doesn't need to know what `T` is — it works the same way for `int`, `std::string`, or a custom struct.
- **Subtype polymorphism** — an object of a derived type can be used anywhere an object of the base type is expected, and the concrete behavior depends on the object's actual run-time type.

In C++, these three categories map (with some simplification) onto concrete language mechanisms:

| Category (Cardelli/Wegner) | C++ mechanism                              | Resolved at  |
| -------------------------- | ------------------------------------------ | ------------ |
| Ad-hoc                     | function overloading, operator overloading | compile time |
| Parametric                 | templates                                  | compile time |
| Subtype                    | `virtual` + inheritance                    | run time     |

What we informally call "static polymorphism" in everyday conversation is, in practice, a combination of overloading and templates — both are resolved entirely by the compiler before the program ever runs. "Dynamic polymorphism" almost always means subtype polymorphism implemented via `virtual`.

It's worth remembering this map, because later, when we discuss `std::variant` or concepts, we'll essentially be asking: which of these three categories — or rather, which language mechanism — best fits a given problem.

### 2. Dynamic polymorphism — how it works under the hood

Let's start with the mechanism most C++ programmers learn first: inheritance and virtual functions.

```cpp
struct Shape {
    virtual double area() const = 0;
    virtual ~Shape() = default;
};

struct Circle : Shape {
    double radius;
    double area() const override { return 3.14159 * radius * radius; }
};

struct Rectangle : Shape {
    double width, height;
    double area() const override { return width * height; }
};

void printArea(const Shape& s) {
    std::cout << s.area() << "\n"; // which area()? decided at run time
}
```

The key question is: how does `printArea` know whether to call `Circle::area` or `Rectangle::area`, given that at compile time the compiler only knows the static type `const Shape&`?

The answer is the **vtable** (virtual table) and **vptr** (virtual pointer) — a mechanism that, in practice (though not mandated by the standard), every serious compiler implements.

**Concretely, here's how it works:**

1. For every polymorphic class (i.e., one with at least one `virtual` function), the compiler generates **a single, static table of function pointers** — the vtable. One table per class, not per object.
2. Every object of that class gets an extra, hidden field — the **vptr**, a pointer that points to the vtable corresponding to its actual runtime type. This pointer is set up in the constructor.
3. A virtual call `s.area()` compiles down to something like: "follow `s`'s vptr, find the entry corresponding to `area` in the table, call the function at that address." This is **dispatch through double indirection** — first to the vtable, then to the function.

Schematically, for our example:

```
Circle object:        Circle vtable:
+-------------+        +------------------+
| vptr        | -----> | &Circle::area    |
| radius      |        | &Circle::~Circle |
+-------------+        +------------------+

Rectangle object:     Rectangle vtable:
+-------------+        +---------------------+
| vptr        | -----> | &Rectangle::area    |
| width       |        | &Rectangle::~Rect.  |
| height      |        +---------------------+
+-------------+
```

This construction has several direct consequences worth remembering for later:

- **Memory overhead**: every polymorphic object carries an extra pointer (typically 8 bytes on 64-bit platforms) — regardless of how many virtual functions it has.
- **Dispatch time cost**: a virtual call is always at least one extra memory indirection compared to a static call. That's usually a small cost, but in a hot loop executed millions of times, it can add up.
- **Loss of inlining (in the general case)**: the compiler usually can't inline a virtual call, because at the call site it doesn't know the concrete type of the object. This is, in practice, a much more significant cost than the indirection itself — inlining opens the door to further optimizations (constant folding, dead code elimination) that simply can't happen across a virtual call boundary. (Modern compilers can sometimes work around this via _devirtualization_ — more on that shortly.)
- **Cache misses**: jumping around vtables and scattered polymorphic objects in memory (e.g., through `vector<unique_ptr<Base>>`) is worse for the CPU cache than working on a contiguous block of data of the same type.

One caveat worth adding: modern compilers (Clang and GCC at appropriate optimization levels) can perform **devirtualization** — if, at a given point in the code, the compiler can statically prove the object's actual type (e.g., because it sees a construction like `Circle c; c.area();` with no polymorphic reference in between), it will replace the virtual call with a plain, static call and potentially inline it. This is an important caveat to any "virtual is always slow" claim — in practice it depends heavily on what the optimizer can see.

### 3. Static polymorphism — how it works under the hood

The second mechanism has no single common denominator in the form of a vtable — because, fundamentally, there's no _runtime_ mechanism here at all. "Dispatch" happens entirely during compilation, and the physical effect is **separate machine code being generated for each combination of types actually used**.

```cpp
template <typename Shape>
double totalArea(const Shape& s) {
    return s.area(); // which area()? decided by the compiler, based on Shape's type
}

struct Circle {
    double radius;
    double area() const { return 3.14159 * radius * radius; }
};

struct Rectangle {
    double width, height;
    double area() const { return width * height; }
};

totalArea(Circle{5.0});      // generates totalArea<Circle>
totalArea(Rectangle{3, 4});  // generates totalArea<Rectangle>
```

Here there's no common base type, no `virtual`, no vtable. `Circle` and `Rectangle` are linked only by the fact that both happen to have an `area()` method with a compatible signature — this is a form of compile-time _duck typing_ (informally, pre-C++20, through SFINAE; formally, from C++20 onward, through concepts — we'll return to this in Part 3).

When the compiler sees two different calls to `totalArea` with two different types, it literally **generates two different functions** — `totalArea<Circle>` and `totalArea<Rectangle>` — each specialized, with the concrete `Shape` type substituted everywhere the template parameter appeared in the source code. This process is called **monomorphization** (though in the C++ context people more often just call it _template instantiation_).

The effect is that inside `totalArea<Circle>`, the call `s.area()` is essentially a plain, static call to `Circle::area()` — the compiler knows the exact type, can inline it freely, and can keep optimizing the code as if there were never any polymorphism involved. This is exactly where the "zero-cost abstraction" slogan comes from — in the generated machine code, there's simply no trace of polymorphism left, because the "decision" of which `area()` to call was made and consumed entirely at compile time.

**The price for this is different from dynamic polymorphism — we don't pay at run time, but along two other axes:**

- **Compile time**: every new combination of types the template is called with is a new instantiation — new code to compile. Large projects with elaborate template hierarchies (see: Boost, Eigen) can have compile times measured in minutes for a single translation unit.
- **Binary size (code bloat)**: if we call `totalArea` for ten different shape types, we end up with ten separate copies of the compiled code for that function in the final binary — even if logically they all do exactly the same thing. Linkers can sometimes merge identical sections (_identical code folding_), but this isn't guaranteed or universal.

### 4. The key distinction: open set vs. closed set of types

This is, in my view, the single most important conceptual axis in this entire topic — more important than performance, and it's the one that should drive your design decision first.

**Dynamic polymorphism operates on an open set of types.** A library can define a `Shape` interface, compile itself, and be distributed as a ready-made shared library (`.so`/`.dll`). A year later, someone else, in a completely separate project, can write `struct Triangle : Shape` and pass an object of that type into a function that accepts `const Shape&` — and it will just work, even though that function's code was compiled before `Triangle` ever existed. This is the foundation of things like:

- plugin architectures (a graphics editor that loads third-party filters as `.so` libraries),
- separate compilation of large systems, where different modules are compiled independently and only linked together at the end,
- heterogeneous containers whose contents are determined at run time (e.g., based on input data or configuration).

**Static polymorphism operates on a closed set of types, fully known at compile time.** `totalArea<Circle>` and `totalArea<Rectangle>` must exist in the same translation unit (or at least the compiler must have access to the template's definition and the concrete types at the point of instantiation — hence the notorious requirement to keep template code in header files). There's no way to "add" a new type to a closed set without recompiling the code that works with that template.

This difference has a direct impact on system architecture:

> **The question worth asking first — before you even think about performance — is: is the set of types I'll be working with inherently closed and fully known while I'm writing the code, or will it be extended by third parties, at a time I don't control?**

If you're writing an AST parser, where tree nodes form a finite, known-in-advance set (`NumberLiteral`, `BinaryOp`, `Identifier`...) — that's a natural candidate for a static solution (e.g., `std::variant`, more on that in Part 3). If you're writing a GUI framework, where every widget is potentially a separate, unknown-to-you class supplied by the library's user — that's a natural candidate for `virtual`.

Performance is a real factor, but in practice, this question about the openness of the type set is what most often rules out one of the options from the start, before you've even measured anything with a profiler.

---

## Part 2: Design Consequences

### 5. Comparison table — the trade-offs

With the foundations behind us, we can lay both approaches side by side more systematically.

| Criterion                                         | Dynamic (`virtual`)                                      | Static (templates)                                                                |
| ------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| When dispatch is resolved                         | Run time                                                 | Compile time                                                                      |
| Set of types                                      | Open — can be extended without recompiling existing code | Closed — must be known at compile time                                            |
| Run-time cost                                     | Vtable indirection, limited inlining                     | Usually zero-cost, full inlining                                                  |
| Object memory cost                                | +1 pointer (vptr) per object                             | No extra overhead                                                                 |
| Compile time                                      | Usually faster (one implementation of the function)      | Can grow drastically with the number of instantiations                            |
| Binary size                                       | Usually smaller                                          | Can grow (code bloat) with the number of instantiations                           |
| Compiler error readability                        | Usually clear (plain inheritance errors)                 | Can be very verbose (though concepts improve this)                                |
| Separate compilation / ABI                        | Naturally supported, stable ABI is achievable            | Template code usually needs to live in headers, harder to get a stable ABI        |
| Run-time polymorphism through a pointer/reference | Yes, via `Base&`/`Base*`                                 | No — a concrete type is needed at compile time                                    |
| Testing / mocking                                 | Easy by swapping the interface implementation            | Requires different techniques (e.g., templating on a test type, "policy" pattern) |

This table isn't a verdict — it's a list of real trade-offs, each of which carries different weight depending on the specific project. Safety and readability of errors also depend heavily on which standard version you're using (C++20 with concepts radically improves the situation on the template side).

### 6. When dynamic makes sense

Beyond the obvious "when I need runtime polymorphism," it's worth listing concrete scenarios where `virtual` is not just acceptable but genuinely the natural choice:

**Plugin architecture.** A host application defines an interface (e.g., `class AudioEffect { virtual void process(Buffer&) = 0; };`), and plugin vendors ship shared libraries implementing that interface, compiled entirely independently of the host. This is a direct example of the open type set from point 4 — without `virtual` (or an equivalent type-erasure mechanism), this architecture couldn't exist at all.

**Heterogeneous containers whose contents depend on run-time data.** A classic example: a document parser that builds a tree of `Shape` objects based on an input file — the type of each object (`Circle`, `Rectangle`, `Polygon`) is only known while parsing, not at compile time.

**Run-time-configurable strategies (Strategy pattern).** The choice of algorithm (e.g., a compression strategy, a sorting algorithm, a caching strategy) depends on configuration loaded at run time (a config file, a CLI flag, a user setting) — this can't be resolved at compile time, because at compile time we simply don't yet know the answer.

**Module boundaries in large systems.** When you want to decouple the compilation of two large subsystems so that a change in one doesn't force a recompile of the other — a stable interface based on abstract classes (often wrapped in the _Pimpl_ idiom, or full type erasure) is the standard tool for this.

### 7. When static makes sense

**Performance-sensitive code, called in hot loops.** If a profiler shows that the cost of virtual dispatch (and especially the lost inlining) is a real bottleneck — and the type set is closed — moving to templates is often justified. A classic example is numerical libraries (Eigen, Blaze), where every tiny arithmetic operation must be inlined, or else the dispatch overhead would dominate the time of the operation itself.

**Header-only libraries where genericity is the whole point of the library's existence.** `std::sort` works for any type satisfying the _RandomAccessIterator_ requirements — if it were implemented via `virtual`, we'd pay dispatch overhead on every element comparison, which for an algorithm performing O(n log n) comparisons would be devastating.

**Zero-cost abstractions as a design philosophy for the whole library.** The STL is the flagship example here — containers and algorithms are generic via templates precisely so that the abstraction (container, iterator, algorithm) doesn't cost anything compared to hand-written, specialized code.

**Strong typing and compile-time validation.** Templates (especially with concepts) let you catch type errors already at compile time, instead of waiting for an exception or incorrect behavior at run time — which is valuable regardless of performance considerations.

---

## Part 3: Applications and Patterns

Foundations and trade-offs are behind us. Time for concrete tools from modern C++ that, in practice, fill the space between pure `virtual` and pure templates.

### 8. CRTP as static polymorphism

CRTP (_Curiously Recurring Template Pattern_) is a technique where the base class is a template parameterized by... its own derived class:

```cpp
template <typename Derived>
struct ShapeBase {
    double area() const {
        // "virtual-like" call, but resolved at compile time
        return static_cast<const Derived*>(this)->areaImpl();
    }
};

struct Circle : ShapeBase<Circle> {
    double radius;
    double areaImpl() const { return 3.14159 * radius * radius; }
};

struct Rectangle : ShapeBase<Rectangle> {
    double width, height;
    double areaImpl() const { return width * height; }
};

template <typename Shape>
void printArea(const ShapeBase<Shape>& s) {
    std::cout << s.area() << "\n"; // no vtable, full inlining
}
```

CRTP gives you something that looks and "feels" like subtype polymorphism — a common base class, a shared interface, something resembling `override` — but the whole dispatch happens at compile time via `static_cast`, without any vtable, without any run-time overhead. The key limitation: `Circle` and `Rectangle` aren't actually related through a common base type in the run-time sense — `ShapeBase<Circle>` and `ShapeBase<Rectangle>` are two entirely different types. You can't have a `std::vector<ShapeBase<?>*>` holding both at once — we're back to the closed-set-of-types problem from point 4.

**When does CRTP actually pay off**, versus being an unnecessary complication? CRTP makes sense when:

- you need a static, zero-cost "shared skeleton" of behavior (typical examples: `enable_shared_from_this`, mixins that add comparison operators based on one defined method),
- you don't need to store a heterogeneous collection of objects through a common base pointer,
- you're willing to accept greater syntactic complexity (templates, `static_cast<Derived*>(this)`) in exchange for performance.

If you don't need any of the above, plain `virtual` is usually clearer and less surprising to the next person reading the code. CRTP is often overused as a "clever trick" in places where plain inheritance would have worked perfectly well.

### 9. `std::variant` + `std::visit` — a third way

`std::variant` is a tool tailored exactly to the scenario from point 4, where the type set is **closed, but heterogeneous** — we're unable (or unwilling) to force a common inheritance hierarchy onto these types, but we want a single variable that can hold any one of several fixed types:

```cpp
struct Circle { double radius; };
struct Rectangle { double width, height; };
struct Triangle { double base, height; };

using Shape = std::variant<Circle, Rectangle, Triangle>;

double area(const Shape& s) {
    return std::visit([](const auto& shape) -> double {
        using T = std::decay_t<decltype(shape)>;
        if constexpr (std::is_same_v<T, Circle>)
            return 3.14159 * shape.radius * shape.radius;
        else if constexpr (std::is_same_v<T, Rectangle>)
            return shape.width * shape.height;
        else if constexpr (std::is_same_v<T, Triangle>)
            return 0.5 * shape.base * shape.height;
    }, s);
}
```

This solution is interesting because in practice it **combines both worlds**: `std::variant` itself doesn't require any common base class or `virtual` — it's a plain tagged union, storing a value of one of the listed types along with information about which one it is. `std::visit`, by invoking the appropriate lambda overload for the currently held type, in a typical implementation relies on a table of function pointers indexed by the active alternative's number — which is technically dispatch "at run time" (since the choice depends on what's actually stored in the `variant` at that moment), but without a vtable and without requiring a common base class.

Advantages compared to a classic `virtual`-based hierarchy:

- **No heap allocation.** `std::variant<Circle, Rectangle, Triangle>` has the size of the largest variant plus a small tag overhead — there's no need for `unique_ptr<Shape>` or any dynamic allocation, unlike with `vector<unique_ptr<Base>>`.
- **Exhaustive matching enforced by the compiler.** If you add a new type to the `variant` but forget to handle it in one of the `std::visit` calls, well-written code (with `if constexpr` ending in a `static_assert(false)` in the `else` branch) will produce a compile error, instead of silently ignoring the new case at run time — something plain `virtual` doesn't give you for free.
- **Values, not pointers.** Value semantics (copying, moving) come naturally and don't require special handling (as with cloning polymorphic objects through a pointer).

The price: the type set must be closed and known up front — exactly like with plain templates. `std::variant` is the right answer to "I have a finite, known list of variants," not to "this library can be extended by third parties."

### 10. Type erasure — a bridge between dynamic and static

Type erasure is a technique that, at first glance, looks like magic: it lets you write code that works on any type satisfying some implicit interface — without forcing that type to inherit from any common base class — while still preserving the ability to store objects of different, unknown-in-advance types in one uniform container or variable.

The best-known example in the standard library is `std::function`:

```cpp
std::function<double(double)> f;

f = [](double x) { return x * x; };       // lambda
f = std::sin;                              // function pointer
struct Multiplier {
    double factor;
    double operator()(double x) const { return x * factor; }
};
f = Multiplier{3.0};                       // function object

f(2.0); // works regardless of what f currently holds
```

`Multiplier`, the lambda, and `std::sin` have absolutely nothing in common with each other — they don't inherit from a shared class, they don't implement any explicit interface. And yet `std::function<double(double)>` is able to store each of them behind the same, uniform API.

The mechanism that makes this possible, in simplified form, looks like this:

```cpp
class FunctionErasure {
    struct ConceptBase {
        virtual double call(double) const = 0;
        virtual ~ConceptBase() = default;
    };

    template <typename Callable>
    struct Model : ConceptBase {
        Callable callable;
        Model(Callable c) : callable(std::move(c)) {}
        double call(double x) const override { return callable(x); }
    };

    std::unique_ptr<ConceptBase> impl;

public:
    template <typename Callable>
    FunctionErasure(Callable c)
        : impl(std::make_unique<Model<Callable>>(std::move(c))) {}

    double operator()(double x) const { return impl->call(x); }
};
```

This is, conceptually, exactly the same `virtual` + vtable mechanism we saw in point 2 — with one important difference: **the base class (`ConceptBase`) and the concrete implementation (`Model<Callable>`) are generated internally by the type-erasure mechanism itself, rather than defined by hand by the library's user**. The user writes a plain lambda or struct with no knowledge of `ConceptBase` whatsoever — and the `Model` template wraps it, on the fly, into an adapter conforming to the required interface.

Type erasure is, quite literally, the bridge this section's title promises: **from the outside it behaves like static polymorphism** (the user writes generic code, no inheritance, the compiler enforces signature compatibility), **and from the inside it behaves like dynamic polymorphism** (it stores different types behind a uniform handle, with dispatch through a vtable at run time). This is the technique behind `std::function`, `std::any`, and — in more elaborate forms — many modern libraries that deliberately avoid imposing inheritance hierarchies on their users (e.g., the technique known as "Sean Parent's runtime concept idiom").

### 11. Concepts (C++20) — structural polymorphism at compile time

The last piece of the puzzle is concepts — a C++20 mechanism that formalizes something people did informally before C++20 via SFINAE.

```cpp
template <typename T>
concept HasArea = requires(const T& t) {
    { t.area() } -> std::convertible_to<double>;
};

template <HasArea Shape>
double totalArea(const Shape& s) {
    return s.area();
}
```

Conceptually, `HasArea` is **duck typing brought into compile time**: `totalArea` doesn't require `Shape` to inherit from any base class — it only requires that `.area()` can be called on it, returning something convertible to `double`. That's exactly the same philosophy as interfaces in duck-typed languages (Python, Go with its implicit interfaces) — except checked and enforced entirely statically, before the program even compiles, rather than discovered through an `AttributeError` at run time.

The biggest practical benefit of concepts in the context of this article is the **radical improvement in compiler error readability** — a topic we already flagged as one of the main weaknesses of "bare" templates. Without concepts, passing a type without an `area()` method into `totalArea` produces a multi-line, unreadable stack of template instantiation errors. With the `HasArea` concept, the error is short and specific: "type `Foo` does not satisfy the requirements of concept `HasArea`, because the expression `t.area()` is invalid."

It's also worth comparing concepts against `virtual`-based interfaces:

|                                   | Interface via `virtual`                                             | Interface via concept                                         |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Conformance                       | Explicit (`class Foo : public Shape`)                               | Structural (implicit — a matching shape is enough)            |
| When checked                      | Partially at compile time (declaration), fully "active" at run time | Fully at compile time                                         |
| Run-time cost                     | Dispatch overhead                                                   | Zero — no run-time polymorphism                               |
| Adding conformance after the fact | Requires changing the class declaration (adding inheritance)        | No class change needed at all — the shape just needs to match |

That last row is particularly interesting: if you have an existing library `struct LegacyCircle { double area() const; };` that you can't modify, but you want it to fit your `HasArea` concept — you don't need to do anything, it just fits, because the concept checks the shape, not a declared inheritance relationship. With `virtual`, you'd have to write an adapter that inherits from your interface and wraps `LegacyCircle`.

---

## Part 4: Wrapping Up

### 12. Decision framework

Instead of another table, let's collect this into a series of questions worth asking, in order, when designing a specific piece of a system:

**Question 1: Is the set of types I'm working with closed and fully known while I'm writing this code?**

- If **no** (the library will be extended by plugins, external modules, code that hasn't been written yet) → you need a run-time mechanism: `virtual` or type erasure.
- If **yes** → you have a choice, move on to question 2.

**Question 2: Do the types in this closed set make sense as a single inheritance hierarchy (a shared "is-a" meaning), or more as a loose set of alternatives?**

- If they fit naturally into a hierarchy and you expect to add more variants as the project grows (even if the set is formally "closed" in a given version) → `std::variant` + `std::visit` is often cleaner than `virtual`, especially if you care about exhaustive matching enforced by the compiler.
- If you need a uniform "handle" for types that have nothing in common besides their shape (like `std::function`) → type erasure.

**Question 3: Is this specific piece of code a measured performance bottleneck?**

- If yes, and you're working with a closed set of types → templates / CRTP give you full inlining and eliminate dispatch overhead.
- If you haven't measured it and only suspect it — don't optimize prematurely. A readable `virtual` is usually a better starting point than premature template genericity, which is harder to maintain later.

**Question 4: Do I need explicit compile-time validation of a type's "shape," with readable error messages, but without forcing inheritance?**

- That's the domain of concepts — especially valuable in header-only libraries, where users shouldn't be forced to inherit from your classes.

### Closing thoughts

Static and dynamic polymorphism in C++ aren't a choice between a "better" and a "worse" option — they're two different tools, designed to solve two different problems that happen to appear disguised in a very similar form ("I want the same code to work for different types"). The key to a good design decision isn't "which is faster," but "is the set of types I'm working with open or closed" — and only then, within the answer to that question, the choice of a specific tool: `virtual`, `std::variant`, CRTP, type erasure, or concepts.

Modern C++ (C++17 and especially C++20) gave us more than just a binary choice between `virtual` and templates — it gave us a whole toolbox, where each tool is the right answer to a different variant of the same fundamental question about the nature of the type set we're working with.
