+++ 
draft = false
date = 2026-07-23T09:41:28+02:00
title = "std::string_view in C++17: The Pitfalls Nobody Warns You About"
tags = ["C++", "std::string_view", "std::string"]
categories = ["C++"]
+++

`std::string_view`, introduced in C++17, promised a simple win: stop copying
strings just to read them. In practice it introduces a new category of bugs
that look exactly like the dangling references and pointers from the
[previous post](/posts/dangling-references-and-pointers/) — except the
non-owning nature of `string_view` makes them easier to write and harder to
spot. This article walks through ten of the most common ways `string_view`
goes wrong, why they happen, and how newer standards change the picture.

## What `string_view` actually is

A `std::string_view` is a lightweight, non-owning view into a contiguous
sequence of characters: just a pointer and a length. It doesn't allocate,
doesn't copy, and doesn't own anything.

```cpp
void print(std::string_view sv) {
    std::cout << sv << '\n';
}

print("hello");           // no allocation, no copy
print(std::string("hi")); // implicit conversion, still no copy
```

That's the entire appeal: passing substrings, literals, or slices of larger
buffers into functions without paying for an allocation. It's also the
entire danger — a `string_view` is only ever as valid as the data it points
to, and nothing in the type system enforces that.

---

## 1. Dangling after returning from a temporary `std::string`

The most direct descendant of the dangling-reference problem:

```cpp
std::string_view get_name() {
    std::string s = "temporary";
    return s; // string_view into s's buffer — s is destroyed on return
}
```

The temporary `std::string` is destroyed at the end of the function, taking
its buffer with it. The returned `string_view` points into freed memory
before the caller even gets a chance to use it.

**Fix:** return `std::string` by value when the data must outlive the
function call. Only return `string_view` when the data it references is
guaranteed to outlive the call — e.g. a `string_view` into a `static`
buffer, a caller-owned string, or a string literal.

---

## 2. Missing null-termination breaking C-style APIs

`string_view` makes no promise that the character sequence is
null-terminated — because it doesn't own the buffer, it has no way to
verify or guarantee that.

```cpp
std::string s = "hello world";
std::string_view sv = std::string_view(s).substr(0, 5); // "hello"

printf("%s\n", sv.data()); // UB: prints past the intended 5 characters
```

`sv.data()` returns a pointer into `s`'s buffer, but `sv.size()` is 5 while
the underlying buffer keeps going until `s`'s actual null terminator.
`printf` doesn't know about `size()` — it reads until it finds `\0`.

**Fix:** never pass `.data()` to a C API expecting a null-terminated
string unless `string_view` covers the entire underlying string. If you
need a C string, materialize a `std::string` first: `std::string(sv).c_str()`.

---

## 3. `substr()` looks like `std::string::substr()`, but the safety story is different

```cpp
std::string s = "hello";
auto s_sub = s.substr(1, 3);           // owning copy: "ell"

std::string_view sv = s;
auto sv_sub = sv.substr(1, 3);         // "ell" — but still a view into s!

s = "changed completely";
std::cout << sv_sub;                   // dangling: s's old buffer may be gone
```

`std::string::substr()` allocates a new, independent string. `string_view::substr()`
just narrows the window — it's still tied to the same underlying storage,
with all the same lifetime constraints as the original view.

**Fix:** treat every `string_view` returned by `substr()` as inheriting the
exact same lifetime constraints as the view it was called on. If the source
string can change or go out of scope, don't hold onto the sub-view.

---

## 4. Building strings through `string_view` concatenation

`string_view` deliberately has no `operator+`. That doesn't stop people from
reaching for patterns that look like it does:

```cpp
std::string_view a = "hello";
std::string_view b = "world";

std::string_view combined = std::string(a) + std::string(b).c_str();
// dangling immediately: the std::string temporaries are destroyed
// at the end of the full expression
```

This compiles because `std::string` has an implicit conversion to
`string_view`, and the whole thing quietly produces a view into memory that
no longer exists by the time `combined` is used.

**Fix:** if you need to build a string, build a `std::string`. Reach for
`string_view` only after concatenation is done, and only if the result
outlives the view.

---

## 5. Storing a `string_view` as a class member

The single most common real-world source of `string_view` bugs — it looks
completely reasonable in isolation:

```cpp
class Logger {
public:
    explicit Logger(std::string_view prefix) : prefix_(prefix) {}

    void log(std::string_view msg) {
        std::cout << prefix_ << ": " << msg << '\n';
    }

private:
    std::string_view prefix_;
};

Logger make_logger() {
    std::string p = "worker-1";
    return Logger(p); // prefix_ views p, which is about to be destroyed
}
```

The constructor accepts `string_view` for efficiency, but nothing forces
the caller to pass something with a long enough lifetime. `prefix_` outlives
the string it was built from the moment `make_logger()` returns.

**Fix:** a `string_view` parameter is fine for functions that use it and
return before the call ends. A `string_view` _member_ is only safe if you
can prove — by design, not by convention — that whatever it points to
outlives every instance of the class. Default to storing `std::string`
in class members; take `string_view` only in the constructor parameter for
short-lived construction work.

---

## 6. `string_view` into a `std::string` that gets modified or reallocated

Same root cause as vector-iterator invalidation, applied to strings:

```cpp
std::string s = "short";
std::string_view sv = s;

s += " but now much, much longer than the small-string-optimization buffer";
// s's internal buffer may have reallocated

std::cout << sv; // dangling if reallocation happened
```

Any operation that can change `s`'s capacity — `append`, `+=`, `insert`,
`resize`, even `reserve` shrinking — can invalidate every `string_view`
that was watching it, exactly like `std::vector::push_back`.

**Fix:** don't hold a `string_view` across any mutating call on the
`std::string` it views. Re-create the view afterward if you still need it.

---

## 7. `string_view` as a key in `std::map` / `std::unordered_map`

```cpp
std::unordered_map<std::string_view, int> counts;

{
    std::string tmp = "apple";
    counts[tmp] = 1; // key is a view into tmp's buffer
} // tmp destroyed here

counts["apple"]; // UB: the stored key is dangling, comparison reads freed memory
```

The map doesn't own the strings its `string_view` keys point to — it never
did, because that's not what `string_view` is for. Every lookup and every
rehash reads through those dangling keys.

**Fix:** use `std::map<std::string, int>` (or `unordered_map`) when the map
needs to own its keys, which is the overwhelmingly common case.
`string_view` keys are only safe when every key genuinely outlives the map —
e.g. a map built once over string literals or over a corpus of strings that
are guaranteed to live longer than the map itself.

---

## 8. Assuming `string_view` is always a free performance win

```cpp
void process(std::string_view sv) {
    std::string s(sv); // copies anyway
    // ... use s ...
}
```

If the function needs an owning `std::string` internally regardless, taking
`string_view` as the parameter type doesn't save anything — it just moves
the copy one line down and adds an extra layer of indirection to reason
about. `string_view` earns its keep only when the function can actually
avoid the copy.

**Fix:** profile before assuming. `string_view` parameters help most for
functions that only read/compare/search without needing ownership. If
you always end up copying into a `std::string` internally, taking
`const std::string&` (or even `std::string` by value, for later moving) may
be simpler and no slower.

---

## 9. Comparisons, hashing, and the small-buffer trap

`string_view` comparisons and hashing are O(n) in the length of the view,
same as `std::string` — there's no shortcut. The performance win of
`string_view` is entirely about avoiding allocation and copying, not about
faster comparisons.

```cpp
std::string_view a = get_large_view();
std::string_view b = get_large_view();

if (a == b) { /* still a full character-by-character comparison */ }
```

This matters when `string_view` gets used purely as a "faster string" in
hot comparison loops — the win from skipping a copy can be dwarfed by
repeated full-length comparisons if the strings are long and comparisons
are frequent.

**Fix:** for comparison-heavy workloads, consider comparing lengths first
(`string_view` makes this free — `size()` is O(1)), or use a hash-based
approach if you're doing repeated equality checks against the same set of
strings.

---

## 10. When _not_ to reach for `string_view` at all

Not every function that reads a string benefits from `string_view`:

```cpp
// Fine: read-only, doesn't outlive the call
bool starts_with_prefix(std::string_view s, std::string_view prefix);

// Risky: caller has no signal that ownership matters here
class Config {
    void set_name(std::string_view name); // stores it? doesn't? unclear from the signature
};
```

A `string_view` parameter tells the caller "I only need to read this, and
only during the call." If the function stores, defers, or hands the data
off to another thread, `string_view` is the wrong signal — and often the
wrong type.

**Fix:** use `string_view` for synchronous, read-only access. Use
`std::string` (by value, to enable moves) whenever the callee needs to keep
the data around.

---

## What changes in C++20, C++23, and C++26

`string_view` itself hasn't needed much revision — most of the ecosystem
around it has caught up instead:

- **C++20** adds `starts_with()` and `ends_with()` directly on `string_view`
  (and `std::string`), removing a common reason people used to reach for
  substring comparisons by hand. `std::span` also arrives in C++20 as the
  generalization of the same idea to arbitrary contiguous ranges — `string_view`
  is effectively `span<const char>` with string-specific conveniences.
- **C++23** adds `contains()` to both `std::string` and `std::string_view`,
  closing another gap that used to push people toward `find() != npos`
  idioms. Ranges support also makes it easier to build pipelines over
  `string_view` without accidentally materializing owning copies along the
  way.
- **C++26** is still evolving as of this writing, but proposals around
  stronger lifetime diagnostics — building on the same lifetime-extension
  reasoning that fixed the range-`for` temporary problem in C++23 — aim to
  let compilers catch a meaningful subset of the dangling-`string_view`
  patterns above at compile time rather than at 2 a.m. in production. Treat
  this as a reason for optimism, not as a reason to stop being careful now.

None of these additions change the fundamental rule: `string_view` never
owns anything, in any standard version, past or future.

---

## General guidelines for `string_view`

- **Treat it as strictly non-owning, always.** Never let a `string_view`
  outlive the object it views — this is the one rule every pitfall above
  boils down to.
- **Prefer it as a function parameter, not a class member.** Parameters
  have an obvious, bounded lifetime. Members don't.
- **Never assume null-termination.** If a C API needs a C string, construct
  a `std::string` explicitly.
- **Don't use it as a map key unless every key provably outlives the map.**
  Default to `std::string` keys.
- **Measure before optimizing.** The win is avoiding allocation, not
  avoiding comparison cost — profile to confirm `string_view` is actually
  buying you something.
- **Reach for `starts_with`/`ends_with`/`contains` (C++20/23)** instead of
  hand-rolled substring checks — less code, fewer chances to get the
  indices wrong.

`string_view` doesn't introduce a new kind of bug so much as it removes the
safety net that made the old kind rare — without an owning buffer to fall
back on, every `string_view` is a bet that something else, somewhere else
in the code, keeps the real data alive long enough. That bet is usually
safe for function parameters and usually wrong for anything that outlives
a single call. Everything above is really just that one distinction,
applied ten different ways.
