+++ 
draft = false
date = 2026-09-08T14:52:02+02:00
title = "shared_ptr vs make_shared - actual differences"
tags = ["C++", "std::shared_ptr", "std::make_shared", "control-block"]
categories = ["C++"]
+++

```cpp
std::shared_ptr<Widget> a(new Widget(1, 2));
std::shared_ptr<Widget> b = std::make_shared<Widget>(1, 2);
```

Both lines give you a `std::shared_ptr<Widget>`. Same type, same public interface, same reference-counting behavior from the outside. But underneath, they build genuinely different things — different allocation patterns, different exception-safety guarantees, and different memory-retention behavior with `weak_ptr`. This post is about that gap, with examples for each difference.

## 1. The control block, and why it exists

Every `shared_ptr` needs somewhere to keep its reference count (how many `shared_ptr`s point at this object), its weak count (how many `weak_ptr`s point at it), and the deleter/allocator used to destroy it. That bookkeeping object is called the **control block**, and it's separate from the managed object itself.

### Direct construction: two allocations

```cpp
std::shared_ptr<Widget> a(new Widget(1, 2));
```

This line does two separate heap allocations:

1. `new Widget(1, 2)` allocates the `Widget` itself.
2. The `shared_ptr` constructor then allocates a **second**, separate block for the control block, and links it to the `Widget` pointer it was just handed.

```
Heap allocation #1:  [ Widget object ]
Heap allocation #2:  [ control block: refcount=1, weak count=0, deleter ]
       shared_ptr →→ points at #1
       (control block →→ points at #1 too, for the eventual delete)
```

### `make_shared`: one allocation

```cpp
std::shared_ptr<Widget> b = std::make_shared<Widget>(1, 2);
```

`make_shared` allocates a **single** block of memory large enough for both the `Widget` and the control block together, then constructs the `Widget` in-place inside that one allocation:

```
Heap allocation #1:  [ control block: refcount=1, weak count=0, deleter | Widget object ]
       shared_ptr →→ points into the middle of this one block, at the Widget part
```

That's the entire structural difference this whole article follows from: one allocation vs. two, and the object living inside the control block's allocation vs. next to it.

## 2. Performance: fewer allocations, better cache locality

### Fewer calls into the allocator

```cpp
// Two malloc calls (or two calls into your custom global allocator)
std::shared_ptr<Widget> a(new Widget(1, 2));

// One malloc call
std::shared_ptr<Widget> b = std::make_shared<Widget>(1, 2);
```

Every heap allocation has real overhead — bookkeeping in the allocator, potential lock contention in a multithreaded allocator, and fragmentation risk. Cutting two allocations down to one is a measurable win, especially in code that creates many `shared_ptr`s (a big loop building a tree/graph of nodes, for example).

### A loop, side by side

```cpp
std::vector<std::shared_ptr<Widget>> widgets;
widgets.reserve(10000);

// Version A: 20,000 total allocations (2 per shared_ptr)
for (int i = 0; i < 10000; ++i) {
    widgets.push_back(std::shared_ptr<Widget>(new Widget(i)));
}

// Version B: 10,000 total allocations (1 per shared_ptr)
for (int i = 0; i < 10000; ++i) {
    widgets.push_back(std::make_shared<Widget>(i));
}
```

Version B does half the allocator calls, and on top of that, each `Widget`'s data and its control block sit right next to each other in memory — meaning when you later dereference the `shared_ptr` and also touch its ref count (e.g., during a copy), both accesses are more likely to land in the same cache line. Version A's `Widget` and its control block are two unrelated heap allocations that could end up anywhere relative to each other.

## 3. Exception safety: the classic argument-evaluation gotcha

### The historical bug

```cpp
void process(std::shared_ptr<Widget> w, int priority);

process(std::shared_ptr<Widget>(new Widget(1, 2)), compute_priority());
```

Before C++17, the standard didn't guarantee an order between evaluating the two arguments to `process`. A compiler was permitted to:

1. Evaluate `new Widget(1, 2)` (raw allocation succeeds, raw pointer obtained)
2. Call `compute_priority()` — which throws
3. Never reach step 3, constructing the `shared_ptr` from the raw pointer — meaning the `Widget` from step 1 is **leaked**, because nothing ever took ownership of it before the exception unwound the stack

This was a real, well-known gotcha in pre-C++17 code: the raw `new` and the `shared_ptr` construction that was supposed to immediately own it were two separate steps, with an arbitrary function call potentially interleaved between them by the compiler.

### C++17 narrowed, but didn't eliminate, the risk

C++17 tightened evaluation-order rules for several cases (sequencing between a function's postfix-expression and its arguments, for example), but function _argument_ evaluation order relative to _other arguments_ in the same call is still unspecified as of C++17/20/23 — arguments can still be evaluated in any order relative to each other, just with clearer sequencing rules within each individual argument's evaluation. In other words, this specific shape of bug — allocation and ownership-taking being two separable steps that another argument's evaluation can land between — is still structurally possible; it isn't something later standards outright forbade for the general case.

### `make_shared` sidesteps the whole problem

```cpp
process(std::make_shared<Widget>(1, 2), compute_priority());
```

There's no raw `new` exposed at the call site at all — allocation and ownership are a single, atomic step inside `make_shared` itself. There's no window where an unowned raw pointer could exist for another argument's evaluation to land between. This is true regardless of standard version; it's not something C++17 made necessary, it's just structurally unavailable as a bug in the first place.

**Rule of thumb:** if you ever see `std::shared_ptr<T>(new T(...))` written directly as a function argument (rather than as its own named variable on its own line), that's worth flagging in review — not because it's automatically broken in modern C++, but because `make_shared` removes the question entirely, for free.

## 4. Where `make_shared` can't or shouldn't be used

### Custom deleters

`make_shared` has no parameter for a custom deleter — it always uses the ordinary `delete` (or, with `allocate_shared`, your allocator's deallocation) to destroy the object it created. If you need a custom deleter (closing a file handle, calling a C library's specific cleanup function, etc.), you need direct construction:

```cpp
std::shared_ptr<FILE> file(
    fopen("data.txt", "r"),
    [](FILE* f) { if (f) fclose(f); } // custom deleter — make_shared has no equivalent parameter
);
```

### Private or protected constructors

`make_shared` needs to call the type's constructor itself, from outside the class — so a `private`/`protected` constructor blocks it, unless you grant access:

```cpp
class Widget {
public:
    static std::shared_ptr<Widget> create(int x, int y) {
        return std::shared_ptr<Widget>(new Widget(x, y)); // direct construction —
    }                                                       // has access, being a member
private:
    Widget(int x, int y) : x_(x), y_(y) {}
    int x_, y_;
};

// std::make_shared<Widget>(1, 2); // ERROR — make_shared can't reach the private constructor
auto w = Widget::create(1, 2);     // works — factory function has member access
```

This is a real, common tradeoff: making a constructor private to force construction through a named factory function loses you the single-allocation optimization, unless the factory function itself uses `allocate_shared` with a friend-granted custom allocator — a more advanced workaround most code doesn't bother with.

### The `weak_ptr` memory-retention subtlety

This is the least obvious difference, and worth an example on its own. With direct construction, the object and control block are separate allocations — so the object's memory can be freed as soon as the **last `shared_ptr`** goes away, even if `weak_ptr`s referencing it still exist (they just start returning "expired" afterward, but their own tiny allocation for the control block stays alive a bit longer until the last `weak_ptr` is also gone):

```cpp
// Direct construction: object memory freed independently of weak_ptr count
std::weak_ptr<Widget> weak;
{
    std::shared_ptr<Widget> s(new Widget(1, 2));
    weak = s;
} // s destroyed here — the Widget's memory (allocation #1) is freed NOW,
  // even though `weak` still exists; only the separate control block
  // (allocation #2) lingers until `weak` also goes away
```

With `make_shared`, the object and control block are **one allocation** — so that single block can't be freed until _both_ the last `shared_ptr` and the last `weak_ptr` are gone, because the object's storage and the control block's storage are the same memory:

```cpp
// make_shared: the ENTIRE combined block, including the Widget's storage,
// stays allocated until the last weak_ptr is also gone
std::weak_ptr<Widget> weak;
{
    std::shared_ptr<Widget> s = std::make_shared<Widget>(1, 2);
    weak = s;
} // s destroyed here — Widget's destructor runs, but the underlying memory
  // (which also holds the control block) is NOT freed yet, because `weak`
  // is still alive; the memory stays reserved until weak also disappears
```

In practice this rarely matters — but it's a genuine tradeoff, not a hypothetical one: if you have a long-lived `weak_ptr` and a large object managed via `make_shared`, that object's memory footprint stays reserved for as long as the `weak_ptr` does, even though the object itself was destroyed. Direct construction doesn't have this coupling, because the two allocations are independent.

## 5. C++20 / C++23 changes specifically

### C++20: array support finally arrives for `make_shared`

Before C++20, `shared_ptr` itself supported managing arrays (`std::shared_ptr<Widget[]>`, since C++17), but `make_shared` had no array overload at all — you had to fall back to direct construction (or a third-party helper like `boost::make_shared`) for array types. C++20 closed that gap:

```cpp
auto arr1 = std::make_shared<int[]>(10);       // 10 ints, default-initialized (value 0
                                                 // for int specifically, since int's
                                                 // "default init" for this overload
                                                 // means value-initialization)
auto arr2 = std::make_shared<int[]>(10, 42);    // 10 ints, each initialized to 42
arr1[3] = 99;                                    // shared_ptr<T[]> supports operator[]
```

Compare to the pre-C++20 direct-construction equivalent, which was the only option before this:

```cpp
std::shared_ptr<int[]> arr3(new int[10]{}); // still valid, still works today,
                                              // but now make_shared covers this case too
```

### C++20: `make_shared_for_overwrite` — skip default initialization

Also new in C++20: a variant that default-initializes rather than value-initializes, useful when you're about to overwrite every element anyway and don't want the (small but real) cost of zero-initializing first:

```cpp
auto buf = std::make_shared_for_overwrite<int[]>(1000); // elements are uninitialized —
                                                           // you must write to each one
                                                           // before reading it, same rule
                                                           // as a raw new int[1000] without {}
for (int i = 0; i < 1000; ++i) {
    buf[i] = compute(i); // fine — every element is written before any read
}
```

### C++20: `std::atomic<std::shared_ptr<T>>`

Before C++20, sharing a single `shared_ptr` across threads safely (where the pointer itself, not just the pointee, might be reassigned concurrently) required a set of free functions: `std::atomic_load`, `std::atomic_store`, `std::atomic_compare_exchange_weak`, and so on, operating on a `shared_ptr<T>*`. C++20 replaces that with an actual `std::atomic` specialization:

```cpp
// Old style (still works, but now considered the legacy approach)
std::shared_ptr<Widget> g_widget = std::make_shared<Widget>();
// ... on another thread:
std::shared_ptr<Widget> local = std::atomic_load(&g_widget);

// C++20 style — an atomic object, not a free-function convention
std::atomic<std::shared_ptr<Widget>> g_widget2 = std::make_shared<Widget>();
// ... on another thread:
std::shared_ptr<Widget> local2 = g_widget2.load();
g_widget2.store(std::make_shared<Widget>()); // atomically swap in a whole new Widget
```

This is a genuinely nicer API — it reads as an ordinary atomic object rather than a set of free functions you have to remember to use consistently everywhere the variable is touched, and it's harder to accidentally bypass (nothing stops you from just writing `g_widget = ...` directly with the old style, silently skipping the atomicity).

### C++23: `std::out_ptr` and `std::inout_ptr` — bridging to C APIs

C++23 introduced `std::out_ptr`/`std::inout_ptr`, adapter helpers for the extremely common pattern of a C API that fills in a pointer through an output parameter (`T**`). This isn't a `shared_ptr`-specific feature, but it interacts with `shared_ptr` in a way worth knowing:

```cpp
// A C-style API: void some_c_api_open(MyHandle** out);
std::shared_ptr<MyHandle> h;
some_c_api_open(std::out_ptr(h, my_handle_deleter)); // std::out_ptr adapts h into a
                                                       // MyHandle** for the C call,
                                                       // then stores the result into h
                                                       // via h.reset(...) once the
                                                       // adapter is destroyed
```

Since `shared_ptr` needs a deleter supplied per-object (rather than baked into the type, the way `unique_ptr<T, D>` does), `std::out_ptr` requires you to pass that deleter explicitly when adapting a `shared_ptr`. Note also that `std::inout_ptr` — the variant for APIs that free an existing pointer before returning a new one — is explicitly **disallowed for `shared_ptr`** by the standard, since that pattern assumes unique-ownership release semantics that shared ownership can't provide safely.

### Looking ahead: `constexpr shared_ptr` (targeting C++26)

As of this writing, there's an active proposal (P3037) working through the committee to make `shared_ptr` (and its friends) usable in `constexpr` contexts, targeting C++26. This is still in progress rather than settled — worth checking current WG21 status before relying on it, since the exact scope (which constructors, which operations) has been narrowed and revised across multiple proposal revisions. Not something to write production code against yet, but a sign of where `shared_ptr` is headed.

## 6. Head-to-head comparison

|                                               | Direct construction (`shared_ptr<T>(new T(...))`)            | `make_shared<T>(...)`                                                 |
| --------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Heap allocations**                          | 2 (object + control block, separate)                         | 1 (combined)                                                          |
| **Cache locality**                            | Object and control block may be far apart                    | Object and control block adjacent                                     |
| **Exception safety at a call site**           | Historically riskier if used inline as an argument           | Safe by construction — no exposed raw `new`                           |
| **Custom deleter support**                    | Yes                                                          | No                                                                    |
| **Works with private/protected constructors** | Yes, from a member/friend context                            | No (needs external access)                                            |
| **`weak_ptr` memory retention**               | Object memory freed independently of outstanding `weak_ptr`s | Combined block stays allocated until the last `weak_ptr` is also gone |
| **Array support**                             | Yes, since C++17 (`shared_ptr<T[]>`)                         | Yes, since C++20                                                      |
| **Skip default-initialization**               | `new T[n]` without `{}`                                      | `make_shared_for_overwrite` (C++20)                                   |

## 7. Decision cheat sheet

| Situation you're in                                                                                                                | Use                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| General case — no special deleter, no access restrictions                                                                          | `make_shared` (the default choice)                                                           |
| You need a custom deleter (file handles, C API cleanup, etc.)                                                                      | Direct construction with a deleter argument                                                  |
| The type's constructor is private/protected, reached via a factory                                                                 | Direct construction inside the factory (member/friend access)                                |
| Managing a dynamically-sized array                                                                                                 | `make_shared<T[]>(n)` (C++20) or direct `shared_ptr<T[]>(new T[n])`                          |
| You're about to overwrite every element and don't need zero-init                                                                   | `make_shared_for_overwrite` (C++20)                                                          |
| Sharing one `shared_ptr` variable across threads with reassignment                                                                 | `std::atomic<std::shared_ptr<T>>` (C++20), not the old free functions                        |
| Adapting a C API that fills a pointer via an output parameter                                                                      | `std::out_ptr` (C++23), with an explicit deleter for `shared_ptr`                            |
| A large object with a long-lived `weak_ptr` where memory footprint during that "expired but not-yet-fully-released" window matters | Consider direct construction, to decouple the object's memory from the `weak_ptr`'s lifetime |

## 8. One-line summary

**Default to `make_shared`** — fewer allocations, better cache locality, and no exception-safety footgun at the call site, for free. **Fall back to direct construction** only when you actually need something `make_shared` structurally can't give you: a custom deleter, access to a private constructor, or (rarely) independence between the object's memory lifetime and an outstanding `weak_ptr`'s lifetime.
