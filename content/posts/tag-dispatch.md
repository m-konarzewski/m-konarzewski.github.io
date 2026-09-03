+++ 
draft = false
date = 2026-07-30T09:39:12+02:00
title = "Tag dispatch in C++: Compile-time pattern that refuses to die"
description = ""
tags = ["C++", "C++20", "Tag dispatch", "Concepts", "SFINAE", "Templates"]
categories = ["C++"]
+++

## 1. Introduction — what problem are we solving?

Every non-trivial C++ codebase eventually runs into the same question: _how do I select a different implementation depending on the type I'm working with, without paying for that decision at runtime?_

The naive answer is a runtime branch — an `if`, a `switch`, maybe a virtual call. But when the "different behavior" is fully known at compile time (because it depends on a type, not on a value), a runtime check is not just wasteful, it's a missed opportunity. The compiler already knows which branch you need. It should pick it for you, at compile time, with zero overhead and — ideally — zero chance of picking the wrong one.

This is where **tag dispatch** enters the picture. It's one of the oldest metaprogramming idioms in C++, predating `enable_if`, predating variadic templates, and certainly predating concepts. It was the STL's original answer to the problem of "I have five kinds of iterators and I need five different algorithms," and it's baked so deeply into the standard library that most C++ developers use it every day without realizing it.

A good way to feel the problem before seeing the solution: imagine you're implementing your own version of `std::advance`. For a `std::vector<int>::iterator`, advancing by `n` is a single pointer addition — O(1). For a `std::list<int>::iterator`, there's no such shortcut; you must walk the list node by node — O(n). The _algorithm itself_ has to change based on the iterator's capabilities, and those capabilities are a compile-time property of the type. This is exactly the kind of problem tag dispatch was built for, and it's the running example we'll use throughout this article — tying back to the iterator category discussion from earlier in this series.

## 2. The mechanics of tag dispatch — how it actually works

At its core, tag dispatch is nothing more than **function overloading driven by an empty marker type**. Strip away the STL ceremony and you get something almost embarrassingly simple.

### Step 1: Define the tags

Tags are typically empty structs. They carry no data — their entire purpose is to exist as a distinct _type_ that the compiler can use for overload resolution.

```cpp
struct tag_fast {};
struct tag_slow {};
```

### Step 2: Write tagged overloads

Each overload takes an extra, otherwise-unused parameter of a tag type. The parameter exists purely to steer overload resolution — you'll rarely even give it a name.

```cpp
void do_work_impl(int x, tag_fast) {
    // an optimized, specialized path
    std::cout << "fast path: " << x * 2 << '\n';
}

void do_work_impl(int x, tag_slow) {
    // a general, possibly slower path
    std::cout << "slow path: " << x + x << '\n';
}
```

### Step 3: Dispatch based on a compile-time condition

A public-facing function computes (or is handed) the correct tag type and forwards to the right overload. The compiler resolves the call at compile time — there is no branching instruction in the generated code for the dispatch itself.

```cpp
template <typename T>
void do_work(T x) {
    using tag = std::conditional_t<std::is_integral_v<T>, tag_fast, tag_slow>;
    do_work_impl(x, tag{});
}
```

That's the whole pattern. No runtime cost, no virtual table, no branch misprediction — just plain old overload resolution doing the heavy lifting. The "cleverness" of tag dispatch lies entirely in _how_ you compute the tag, not in the dispatch mechanism itself, which is just C++'s ordinary function overloading rules.

It's worth pausing on why this works so well: overload resolution is a compile-time process. By encoding a compile-time fact (is this type integral? does this iterator support random access?) as a _type_ rather than a _value_, we hand the decision to a part of the compiler that was always going to run anyway — and we get a hard compile error, not a runtime bug, if a case is missing.

## 3. The Classic STL Example — `iterator_category`

The textbook illustration of tag dispatch lives inside `<iterator>`, in the implementation of functions like `std::advance` and `std::distance`. Let's trace the full pipeline: **trait → tag → dispatch**.

### The trait

Every iterator type exposes its capabilities through `std::iterator_traits<It>::iterator_category`, which resolves to one of a family of tag types:

```cpp
struct input_iterator_tag {};
struct forward_iterator_tag : input_iterator_tag {};
struct bidirectional_iterator_tag : forward_iterator_tag {};
struct random_access_iterator_tag : bidirectional_iterator_tag {};
```

Notice the inheritance chain — we'll come back to why that matters in section 5.

### The tagged overloads

`std::advance` is conceptually implemented as a set of overloads, each specialized for a category:

```cpp
template <typename It, typename Distance>
void advance_impl(It& it, Distance n, std::random_access_iterator_tag) {
    it += n; // O(1) — pointer arithmetic or equivalent
}

template <typename It, typename Distance>
void advance_impl(It& it, Distance n, std::bidirectional_iterator_tag) {
    if (n >= 0) { while (n--) ++it; }
    else        { while (n++) --it; }
}

template <typename It, typename Distance>
void advance_impl(It& it, Distance n, std::input_iterator_tag) {
    while (n--) ++it; // forward-only, O(n)
}
```

### The dispatcher

```cpp
template <typename It, typename Distance>
void my_advance(It& it, Distance n) {
    advance_impl(it, n,
        typename std::iterator_traits<It>::iterator_category{});
}
```

Call `my_advance` on a `std::vector<int>::iterator` and the compiler statically resolves `iterator_category` to `random_access_iterator_tag`, which selects the O(1) overload — no runtime check of "what kind of iterator is this" ever happens. Call it on a `std::list<int>::iterator` and you transparently get the O(n) walking version. The caller's code — `my_advance(it, 5)` — looks identical in both cases; the divergence is entirely resolved by the compiler before a single instruction is emitted.

This is the pattern's superpower: **the algorithm's shape adapts to the type's capabilities, invisibly, at zero runtime cost.**

## 4. Tag Dispatch vs. the Alternatives

Tag dispatch is not the only tool for compile-time branching, and modern C++ gives you several competitors. Understanding the tradeoffs is really the heart of this article.

### `if constexpr` + type traits/concepts

Since C++17, a huge fraction of tag dispatch's use cases can be replaced with a single function containing `if constexpr`:

```cpp
template <typename It, typename Distance>
void my_advance(It& it, Distance n) {
    if constexpr (std::random_access_iterator<It>) {
        it += n;
    } else if constexpr (std::bidirectional_iterator<It>) {
        if (n >= 0) { while (n--) ++it; }
        else        { while (n++) --it; }
    } else {
        while (n--) ++it;
    }
}
```

This is often _more_ readable for simple cases: everything lives in one function body, you can see all branches at a glance, and there's no need to invent tag types or worry about overload resolution ambiguity. For small, self-contained pieces of logic, this is usually the better default in C++20.

### SFINAE (`enable_if`)

Before tag dispatch fell out of favor for _some_ use cases, it was itself competing with SFINAE-based dispatch:

```cpp
template <typename It, typename Distance,
          typename = std::enable_if_t<is_random_access_v<It>>>
void advance_impl(It& it, Distance n) { it += n; }
```

SFINAE-based overloads accomplish something similar but are notoriously unfriendly: error messages are walls of substitution-failure noise, the intent is buried in template parameter defaults, and getting the constraints exactly right (no accidental overlaps, no accidental gaps) is fiddly. Tag dispatch's separate, clearly-named tag types were historically _more_ readable than the equivalent `enable_if` incantation, which is a large part of why it survived so long as the idiom of choice.

### Concepts (C++20) — "tag dispatch, but the tag is the constraint"

Concepts let you write ordinary overloads constrained directly by a compile-time predicate, without inventing a tag type at all:

```cpp
template <std::random_access_iterator It, typename Distance>
void advance_impl(It& it, Distance n) { it += n; }

template <std::bidirectional_iterator It, typename Distance>
void advance_impl(It& it, Distance n) { /* ... */ }
```

This is, in a real sense, tag dispatch with the tag _inferred_ rather than _materialized_ — the compiler figures out which constraint the type satisfies instead of you computing a tag object and passing it explicitly. You get the same overload-resolution machinery, but with vastly better error messages (concepts report _which constraint_ failed, not a cascade of substitution failures) and no boilerplate tag hierarchy.

### Summary table

| Technique            | Compile-time cost | Error message quality                 | Best for                                                                                    |
| -------------------- | ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Tag dispatch         | Low               | Moderate (overload resolution errors) | Multi-way dispatch across a library boundary; when tags already exist (iterator categories) |
| `if constexpr`       | Low               | Good (linear, in-place)               | Small, local, self-contained branching logic                                                |
| SFINAE (`enable_if`) | High              | Poor (substitution failure walls)     | Legacy code; pre-C++20 constrained overloads                                                |
| Concepts             | Low               | Excellent (named constraint failures) | New code, C++20+, public API boundaries                                                     |

## 5. When tag dispatch still earns its place in C++20

Given `if constexpr` and concepts, is tag dispatch obsolete? Not quite. A few scenarios still favor it.

### Multi-step, hierarchical dispatch

Recall the iterator tag hierarchy from section 3 — `random_access_iterator_tag` _inherits from_ `bidirectional_iterator_tag`, which inherits from `forward_iterator_tag`, and so on. This inheritance means a single overload written for `forward_iterator_tag` will also be selected (via derived-to-base conversion in overload resolution) for anything more capable, unless a more specific overload exists. This gives you "fallback" semantics for free: you write the general case once, and only add a specialized overload where it actually pays off (like the O(1) random-access case). Replicating this with `if constexpr` means manually re-checking "is it at least forward, but not bidirectional" style conditions in every function, which gets unwieldy fast when a library exposes many entry points that all need this same fallback chain.

### Dispatch across a library/API boundary

`if constexpr` bundles all branches into a single function body, which is fine when you own the whole function. But if you're designing a library where _users_ need to plug in behavior for a specific tag (think: customizing `std::advance`-like behavior for a user-defined iterator category), tag dispatch's use of ordinary overloading means users can add new overloads for new tags **without touching your dispatcher function at all**. `if constexpr` offers no equivalent extension point — the branches are closed inside one function.

### Readable compiler diagnostics for overload sets

While concepts generally win on error message clarity, tag dispatch still beats raw SFINAE by a wide margin, and in codebases that can't yet move to C++20 concepts, it remains the most legible option for expressing "pick one of these N implementations based on a compile-time property."

### Integration with ADL

Tag-dispatched functions are ordinary free functions, discoverable via argument-dependent lookup. This means a user-defined type can participate in a dispatch scheme defined in a completely different namespace, simply by ensuring the right tag type is associated with their type — the same mechanism that makes `swap` customization points work.

## 6. Pitfalls and good practices

Like any overload-based technique, tag dispatch has sharp edges.

**Ambiguous overloads with inherited tags.** If you provide overloads for both `forward_iterator_tag` and `bidirectional_iterator_tag`, and a caller passes something whose category is `random_access_iterator_tag`, overload resolution picks the _closest_ base in the inheritance chain — but if your tag hierarchy isn't a strict single-inheritance chain, you can end up with genuine ambiguity that only shows up at the specific call site that triggers it. Keep tag hierarchies linear unless you have a very good reason not to.

**Naming conventions matter.** A common convention is to suffix the tag-taking overload with `_impl` (as in this article) and keep the public-facing name free of the tag parameter, so users never have to think about tags unless they're extending the dispatch set. Some codebases instead put the tag as the _first_ parameter rather than the last — either is fine, but consistency within a codebase avoids surprises.

**Don't forget the tag has to be default-constructible (or you need `{}`).** Since tags are typically empty structs, constructing one with `tag_type{}` is free — but it's an easy detail to forget when writing a new tag type with, say, a deleted default constructor.

**Hybrid approaches are common and reasonable.** It's entirely idiomatic to use tag dispatch at a library's public extension points (where users add overloads for new tags) while using `if constexpr` internally for the private, closed-set branching logic inside your own implementation. Don't treat this as an all-or-nothing choice.

## 7. Summary

Tag dispatch is not a relic — it's a specialized tool that happens to have been the _only_ tool for a long time, which led to it being overused for problems that `if constexpr` and concepts now solve more cleanly. But for the specific job it was built for — extensible, hierarchical, compile-time selection of behavior across a library's overload set — it remains genuinely the best available option, even in C++20.

**Quick guidance:**

- Small, local, closed-set branching → **`if constexpr`**
- Public API constrained by a single compile-time predicate → **concepts**
- Extensible dispatch across a library boundary, especially with a natural hierarchy (like iterator categories) → **tag dispatch**
- Legacy code stuck pre-C++20 → tag dispatch remains more readable than raw SFINAE

The STL's own iterator machinery is proof that this fifty-cent idiom — an empty struct and a few overloads — can carry a standard library's worth of algorithms for decades without needing to change. That's a good argument for keeping it in your toolbox, even next to shinier C++20 alternatives.
