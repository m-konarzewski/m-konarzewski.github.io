+++ 
draft = false
date = 2026-08-27T14:11:13+02:00
title = "dynamic_cast and RTTI:"
tags = ["dynamic-cast", "RTTI", "type-info"]
categories = ["C++"]
+++

If you've spent any time in a C++ code review, you've probably heard some version of the following: _"if you need `dynamic_cast`, your design is wrong."_ It's repeated often enough that many engineers treat it as an axiom rather than a heuristic. Like most heuristics, it captures a real and common failure mode — and like most heuristics, it's frequently applied well past the point where it stops being true.

This article looks at `dynamic_cast` and RTTI from first principles: what problem the mechanism actually solves, how it's implemented, what it costs, and — the part that tends to get skipped — the set of situations where reaching for it is not a symptom of anything, but the correct tool for a problem that virtual dispatch structurally cannot solve.

This isn't a rehash of static-vs-dynamic-polymorphism ground already covered on this blog; the focus here is narrower and deeper: `dynamic_cast` and RTTI as a mechanism in their own right.

## 1. The problem `dynamic_cast` solves

Every polymorphic object in C++ has two types: a **static type**, known to the compiler at the point of use, and a **dynamic type**, which is whatever the object actually is at runtime. When you hold a `Base*`, the compiler knows only the static type. The dynamic type could be `Base`, or any of an open-ended set of derived classes — potentially classes that didn't exist when the base class was written, and won't exist until someone links a plugin against it next year.

`static_cast` operates purely on static-type information. When you write `static_cast<Derived*>(basePtr)`, the compiler trusts you completely: it emits a pointer adjustment based on the _declared_ relationship between `Base` and `Derived`, with zero runtime verification. If `basePtr` doesn't actually point to a `Derived` (or something derived from `Derived`), you get undefined behavior — not a crash, not a null pointer, undefined behavior, which in practice usually means silent memory corruption that surfaces somewhere else entirely.

`dynamic_cast` closes that gap. It asks a question `static_cast` cannot even formulate: _"what is this object's actual dynamic type, right now, and is the cast I'm asking for actually valid for it?"_ That's a fundamentally different operation — it requires runtime type information, which is why `dynamic_cast` only works on polymorphic types (types with at least one virtual function, hence a vtable to hang the type information off of).

### How it's actually implemented

Every polymorphic object carries a pointer to its vtable, and every vtable carries — typically just before the function pointer array, at a fixed negative offset — a pointer to a `std::type_info` object describing the class. That `type_info` object doesn't stand alone: under the Itanium C++ ABI (used by GCC, Clang, and every other non-MSVC compiler), each polymorphic class's `type_info` also encodes its base classes, forming a _base class type-info graph_ that mirrors the inheritance hierarchy. `dynamic_cast` is, at its core, a graph search over this structure: it walks from the object's actual dynamic type toward the requested target type, checking whether a valid public, unambiguous path exists.

This is worth internalizing because it explains everything else in this article:

- Why `dynamic_cast` needs polymorphic types (no vtable, no `type_info`, no graph to walk).
- Why it's slower than a virtual call (a virtual call is one indirect jump; `dynamic_cast` is a bounded graph traversal, plus string comparison of type names on some paths).
- Why cross-casts and multiple-inheritance casts are more expensive than single-inheritance downcasts (bigger graph, more paths to check, possible ambiguity to detect).
- Why it breaks across shared-library boundaries in some configurations (see §7).

## 2. The two forms and what they actually verify

```cpp
Derived* d = dynamic_cast<Derived*>(basePtr);  // pointer form
if (d) { /* cast succeeded */ }

Derived& d = dynamic_cast<Derived&>(baseRef);  // reference form
// throws std::bad_cast on failure — there's no "null reference" to return
```

I verified the reference form's failure behavior directly rather than taking it on faith:

```cpp
struct Base { virtual ~Base() = default; };
struct Derived : Base {};
struct Other : Base {};

Derived d;
Base& b = d;
try {
    Other& o = dynamic_cast<Other&>(b);
} catch (const std::bad_cast& e) {
    std::cout << "caught bad_cast: " << e.what() << "\n";
}
```

```
caught bad_cast: std::bad_cast
```

That asymmetry — `nullptr` for pointers, exception for references — isn't arbitrary. A pointer can meaningfully be null; a reference, by the language's own invariants, cannot be "no object." `dynamic_cast<T&>` has no valid failure value to hand back, so the only type-safe option is to unwind the stack. This is a useful signal in interface design: a function that takes `Derived&` and internally does `dynamic_cast<Specific&>` is asserting the cast _must_ succeed — a logic error, not a runtime condition, if it doesn't. If failure is expected and recoverable, you want the pointer form, checked explicitly.

### Downcast, upcast, and cross-cast

Most engineers can recite the downcast case (`Base*` → `Derived*`) without thinking. Fewer reach for **cross-casts**, which is a shame, because they're where `dynamic_cast` earns its keep in ways nothing else in the language replicates.

| Cast direction                                                        | What it does                                                                    | Needs `dynamic_cast`?                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Upcast (`Derived*` → `Base*`)                                         | Widening; always safe                                                           | No — implicit conversion suffices                                              |
| Downcast (`Base*` → `Derived*`)                                       | Narrowing along one branch of the hierarchy                                     | Only if you need runtime verification; `static_cast` works if you're _certain_ |
| Cross-cast (`SiblingA*` → `SiblingB*`, both bases of the same object) | Sideways move between unrelated base subobjects of the same most-derived object | **Yes, unconditionally** — no other cast in the language can do this           |

The cross-cast case deserves a concrete example, because it's the cleanest demonstration of why `dynamic_cast` is not just "a checked `static_cast`" — it can produce results `static_cast` cannot express at all:

```cpp
struct Serializable { virtual ~Serializable() = default; virtual void save() = 0; };
struct Renderable   { virtual ~Renderable() = default; virtual void draw() = 0; };

struct Widget : Serializable, Renderable {
    void save() override { std::cout << "Widget::save\n"; }
    void draw() override { std::cout << "Widget::draw\n"; }
};

Widget w;
Serializable* s = &w;

Renderable* r = dynamic_cast<Renderable*>(s);   // sideways: Serializable* -> Renderable*
if (r) r->draw();

std::cout << "s ptr: " << s << "\n";
std::cout << "r ptr: " << r << "\n";
```

```
Widget::draw
s ptr: 0x7fff7a344030
r ptr: 0x7fff7a344038
```

Notice the pointer values differ by 8 bytes — `s` and `r` point at different base subobjects _within the same `Widget` instance_. `static_cast` has no way to perform this conversion at all (there's no compile-time-derivable offset between two unrelated base classes without going through the concrete derived type explicitly), and `reinterpret_cast` would silently produce a garbage pointer. `dynamic_cast` is the only construct in the language that can navigate this relationship, because it's the only one that consults the object's actual layout at runtime rather than the static type graph.

## 3. Where "just use virtual functions" stops being good advice

The dogma exists for a real reason: a chain of

```cpp
if (auto* c = dynamic_cast<Circle*>(shape))      c->drawCircle();
else if (auto* s = dynamic_cast<Square*>(shape))  s->drawSquare();
else if (auto* t = dynamic_cast<Triangle*>(shape)) t->drawTriangle();
```

is exactly the kind of type-switch OOP's virtual dispatch mechanism exists to eliminate. It's brittle (add a new shape, forget a branch, get silent wrong behavior instead of a compile error), it violates the open/closed principle, and every one of these branches should be `shape->draw()`. When this pattern shows up, "your design is wrong" is the correct diagnosis, full stop.

But the heuristic quietly assumes something: that the operation you're dispatching on **belongs on the base class's interface**. That assumption fails in specific, recurring situations — and forcing a virtual function onto an interface where it doesn't belong is itself a design cost, often a worse one than an occasional `dynamic_cast`.

Consider a `Shape` base class used by a rendering pipeline. Some derived shapes — not all — support an `exportToSVG()` capability. Adding `virtual void exportToSVG()` to `Shape` forces every shape, including ones with no meaningful SVG representation, to carry that method (as a no-op, a `throw`, or a `return false`). You've widened the base interface for a capability that doesn't universally apply, coupled every derived class to a concern (SVG export) that may belong to a completely different subsystem, and made `Shape` harder to reason about for every reader who now has to figure out which shapes actually implement `exportToSVG()` meaningfully. A `dynamic_cast<SVGExportable*>(shape)` probe, checked once at the export boundary, keeps `Shape` narrow and keeps the SVG-export concern local to the code that actually cares about it.

The pattern generalizes: **virtual functions are the right tool when the operation is part of what every (or nearly every) derived type fundamentally _is_. `dynamic_cast` becomes reasonable when the operation is an optional, cross-cutting _capability_ that only some derived types have, and forcing it into the base interface would pollute that interface for everyone else.**

## 4. Legitimate use cases

### 4.1 Capability / interface probing

This is the pattern from §3 made explicit, and it's arguably the single most common legitimate use of `dynamic_cast` in real systems — it's a lighter-weight, compile-time-checked cousin of COM's `QueryInterface`.

```cpp
struct Plugin { virtual ~Plugin() = default; };
struct IConfigurable { virtual void configure() = 0; virtual ~IConfigurable() = default; };

struct BasicPlugin : Plugin {};
struct AdvancedPlugin : Plugin, IConfigurable {
    void configure() override { std::cout << "AdvancedPlugin configured\n"; }
};

void load(Plugin* p) {
    if (auto* cfg = dynamic_cast<IConfigurable*>(p)) {
        cfg->configure();
    } else {
        std::cout << "Plugin has no configuration interface\n";
    }
}
```

```
Plugin has no configuration interface
AdvancedPlugin configured
```

Every plugin implements `Plugin`; only some additionally implement `IConfigurable`, `ISerializable`, `IUpdatable`, or whatever other optional facets the host application knows to look for. The host doesn't need to know the full set of plugin types in advance — it just probes for the interfaces it cares about. This is exactly the shape of problem `dynamic_cast` is good at: an **open set** of implementers, an **optional** capability, checked at a small number of well-defined boundary points rather than scattered through business logic.

### 4.2 Double dispatch and the Visitor pattern

`dynamic_cast` and the Visitor pattern are often presented as alternatives, but in practice they frequently coexist: `dynamic_cast` shows up _inside_ visitor implementations, either as a fallback path for types that predate the visitor's introduction, or as a targeted optimization when a visitor only cares about one or two concrete types out of a larger hierarchy and doesn't want the ceremony of a full `accept()`/`visit()` override on every class. It's also the natural escape hatch when you're consuming a third-party visitable hierarchy and can't add a new `visit(YourType&)` overload to its `Visitor` base without forking the library.

### 4.3 Boundaries you don't control

This is the case that gets underweighted in "avoid `dynamic_cast`" discussions, because the discussions usually implicitly assume you own the whole hierarchy. You often don't:

- **Deserialization / plugin loading**: you're handed a `Base*` whose dynamic type was determined by a config file, a factory registered by someone else's code, or a `dlopen`'d shared object. Downcasting to something concrete, with verification, is the entire point of the boundary.
- **Third-party library integration**: adapting a library's polymorphic hierarchy to your own code often requires asking "is this actually a `LibrarySpecificType`?" at the seam, because the library wasn't designed with your specific downstream needs in mind and you can't retroactively add virtual functions to its base class.
- **Narrowing at API boundaries**: a public API exposes a polymorphic interface for encapsulation reasons, while internal code occasionally needs to recover the concrete type to do something interface-inappropriate (debug logging, specialized fast paths, format-specific serialization).

In all three cases, the "just add a virtual function" advice doesn't apply because you don't control the base class, or adding the function would leak an implementation-specific concern into a genuinely general-purpose interface.

## 5. `dynamic_cast` vs. the alternatives

| Approach                      | Type set                                                                                 | Dispatch cost                             | Safety                                                                  | Best fit                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Virtual functions             | Open (any future derived type)                                                           | 1 indirect call                           | Compile-time interface, runtime behavior                                | Operation is fundamental to what the type _is_                                           |
| `std::variant` / `std::visit` | **Closed** — fixed at compile time                                                       | Index dispatch, often ~branch-cost        | Compile-time exhaustiveness (`-Wswitch`-style safety with `std::visit`) | Fixed, known set of alternatives; no future extension needed                             |
| CRTP / static polymorphism    | Closed, resolved at compile time                                                         | Zero runtime cost (usually fully inlined) | Compile-time only                                                       | Performance-critical, type set known at compile time, no runtime substitutability needed |
| Tag / enum dispatch           | Closed, manually maintained                                                              | Branch/jump table                         | None — no compiler enforcement of exhaustiveness                        | Legacy code, C interop, or when you specifically want to avoid vtables                   |
| `dynamic_cast`                | **Open**, and — uniquely — works _across_ independently-defined hierarchies (cross-cast) | Graph traversal, see §6                   | Runtime-checked, exception or null on failure                           | Optional capability probing, boundaries you don't control, cross-casts                   |

The column that matters most for choosing between these is the first one. `std::variant` and CRTP require you to know the full set of alternatives at compile time — they're closed-world tools. `dynamic_cast` and virtual functions are open-world: new derived types can appear after the base class is compiled, which is exactly the plugin/deserialization/third-party scenario from §4.3. If your type set is genuinely closed, prefer `std::variant`; you get exhaustiveness checking and no RTTI overhead. If it's open and the operation belongs to every type's core identity, use virtual functions. `dynamic_cast` earns its place specifically in the open-world, optional-capability, or cross-hierarchy corner of this table — a corner none of the closed-world alternatives can occupy at all.

## 6. Performance: measured, not assumed

Given how often "`dynamic_cast` is slow" is stated as received wisdom, it's worth actually measuring it rather than repeating the claim. The setup: three sibling classes derived from a common polymorphic base, a pre-shuffled stream of 20 million pointers (shuffling done _before_ timing starts, so the branch predictor and the RNG aren't part of the measurement), then three passes over the same stream:

```cpp
struct Base {
    virtual ~Base() = default;
    virtual int tag() const { return 0; }
};
struct A : Base {
    int tag() const override { return 1; }
    int payloadA = 1;
};
struct B : Base {
    int tag() const override { return 2; }
    int payloadB = 2;
};
struct C : Base {
    int tag() const override { return 3; }
    int payloadC = 3;
};
// stream: pre-shuffled std::vector<Base*>, 20,000,000 entries, objects of type A/B/C in random
// order

for (auto* p : stream) {
    if (auto* a = dynamic_cast<A*>(p)) {  // dynamic_cast
        hits += a->payloadA;
    }
}
for (auto* p : stream) {
    hits += p->tag();  // virtual call
}
for (auto* p : stream) {
    hits += static_cast<A*>(p)->payloadA;  // unchecked, UB, static_cast
}
```

Compiled with `g++ -O2 -std=c++20`, three runs each, single-inheritance hierarchy:

| Operation                                                                                  | Time (20M iterations) | Relative to virtual call |
| ------------------------------------------------------------------------------------------ | --------------------- | ------------------------ |
| `dynamic_cast<A*>` (checked, 1/3 hit rate)                                                 | ~371 ms               | ~1.9×                    |
| virtual call                                                                               | ~197 ms               | 1× (baseline)            |
| `static_cast` (unchecked — shown only for cost comparison, this is UB for non-`A` objects) | ~28 ms                | ~0.14×                   |

Two things are worth pulling out of this:

1. `dynamic_cast` is roughly **2×** the cost of a plain virtual call here, not the "50× slower" figure that circulates in some folklore. For single inheritance with no ambiguity to resolve, the Itanium ABI's `__dynamic_cast` implementation is not doing much more work than a virtual call plus a type-info comparison.
2. The gap to _unchecked_ `static_cast` is real (~13×) — but that comparison is somewhat unfair, since `static_cast` here is doing zero verification work by construction. The honest comparison is `dynamic_cast` vs. "the cost of correctness," not vs. "the cost of skipping the check."

One more thing surfaced while preparing these benchmarks, worth noting because it's not commonly discussed: when the target type of a `dynamic_cast` is the object's **most-derived type**, some implementations (GCC's libstdc++ among them) can take a fast path that skips the general graph search entirely, since "is this pointer's dynamic type exactly T" is a cheaper question than "does a path to T exist somewhere in the hierarchy." I could not get a clean isolated measurement of this in a microbenchmark — the compiler's devirtualization pass tends to constant-fold trivial cases involving compile-time-known dynamic types — but it's documented ABI behavior and worth knowing: casting to the exact concrete type (as capability-probing code often does) is generally cheaper than casting to an interior base of a multi-level or multiple-inheritance hierarchy, where the general graph-search path is unavoidable.

For **multiple and virtual inheritance**, expect materially higher cost than the single-inheritance numbers above — the ABI's `__dynamic_cast` has to handle potentially ambiguous paths and virtual base subobject sharing, which the single-inheritance fast paths don't need to consider at all. If `dynamic_cast` shows up in a hot path against a deep or diamond-shaped hierarchy, that's worth profiling specifically rather than assuming the single-inheritance numbers above generalize.

Some domains — game engines and embedded targets being the two recurring examples — build with `-fno-rtti` to shed the `type_info` data and the associated binary size, and `dynamic_cast` simply stops being available:

```
nortti.cpp: In function 'int main()':
nortti.cpp:7:19: error: 'dynamic_cast' not permitted with '-fno-rtti'
```

That's a compile error, not a runtime one — verified directly. Codebases in this position typically reintroduce a lightweight substitute: a manually maintained type-tag enum or `static const void*` "type ID" scheme checked with plain comparisons, giving back most of the capability-probing power at a fraction of the size and none of the graph traversal cost, at the price of the compiler no longer helping you keep the tags consistent with the hierarchy.

## 7. Pitfalls worth knowing about

**Casting across shared-library boundaries.** In some configurations, `type_info` objects for "the same" class compiled into two different shared libraries end up as _distinct_ objects rather than being merged, which can make cross-library `dynamic_cast` fail even though the types are, semantically, identical. The Itanium ABI mitigates this in the common case (default symbol visibility lets the dynamic linker merge weak `type_info` symbols across the executable and its shared libraries via the usual ODR mechanism), but it reliably breaks down under `-fvisibility=hidden` without explicit export annotations, under `RTLD_LOCAL` loading, or when the class in question lives in an anonymous namespace in each library (which is often done deliberately for encapsulation, and is exactly what defeats the merge). If you're building a plugin architecture with `dynamic_cast`-based capability probing across a `dlopen` boundary — precisely the use case in §4.1 — this is the failure mode to test for explicitly, not assume away.

**`dynamic_cast` in constructors and destructors.** This connects to the earlier article on dangling references: during construction, the vtable pointer reflects the _currently-under-construction_ class, not the eventual most-derived type, because the derived-class portion of the object doesn't exist yet. A `dynamic_cast` to a derived type, called from a base class constructor, will not see that derived type — it'll behave as if the object really is only the base (or whatever level of construction has completed), by design, not by bug. The same applies in reverse during destruction. This is one of the reasons `dynamic_cast`-based capability checks belong at stable points in an object's lifetime, not inside its own constructor chain.

**Overuse as a symptom vs. a cause.** The §3 discussion applies here directly: a _chain_ of `dynamic_cast`s standing in for what should be a single virtual call is a real problem, and it's a problem regardless of whether each individual `dynamic_cast` "works." The test that tends to separate legitimate use from design smell isn't "does this compile and run correctly" — it's "is this an optional, cross-cutting capability check at a boundary, or is this reimplementing dispatch that the type hierarchy already exists to provide."

## Summary

`dynamic_cast` exists because `static_cast` cannot verify anything at runtime, and because some relationships — cross-casts chief among them — cannot be expressed by any other cast in the language at all. The "avoid it" heuristic is right when it's catching a type-switch that should be virtual dispatch on the base class's core interface. It stops being right the moment the operation in question is an optional capability that doesn't belong on every derived type, or the hierarchy in question crosses a boundary — a plugin loader, a third-party library, a deserialization seam — that you don't control and can't retrofit with virtual functions. Measured cost is real but modest (roughly 2× a virtual call for the common single-inheritance case) and concentrated in multiple/virtual-inheritance and shared-library scenarios where it's worth profiling explicitly rather than assuming.

---
