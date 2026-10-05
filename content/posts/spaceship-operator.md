+++ 
draft = false
date = 2026-10-02T12:00:18+02:00
title = "The spaceship operator: Ending the six-operator boilerplate"
tags = ["spaceship-operator", "three-way-comparison"]
categories = ["C++"]
+++

## The problem we all lived with

For two decades, C++ asked the same thing of every comparable type: want to compare objects of your own class? Write six operators. `==`, `!=`, `<`, `<=`, `>`, `>=`. By hand. And hope you never make the classic transcription error — `return other < *this;` instead of `*this < other;` — because that kind of bug can sit in a codebase for months before anyone notices the ordering is subtly wrong.

```cpp
struct Point {
    int x, y;

    bool operator==(const Point& o) const { return x == o.x && y == o.y; }
    bool operator!=(const Point& o) const { return !(*this == o); }
    bool operator<(const Point& o) const  { return x != o.x ? x < o.x : y < o.y; }
    bool operator>(const Point& o) const  { return o < *this; }
    bool operator<=(const Point& o) const { return !(o < *this); }
    bool operator>=(const Point& o) const { return !(*this < o); }
};
```

Four of those six functions are entirely derivable from the other two. The standard actually had an answer for this as far back as C++98 — `std::rel_ops` in `<utility>` — but almost nobody used it in practice. It required a `using namespace` directive (namespace pollution, and a real risk of colliding with other overloads), it didn't help with heterogeneous comparisons at all, and it was so obscure that most C++ engineers today have never heard of it. The actual industry answer, when teams bothered to solve this instead of copy-pasting the six functions, was `boost::totally_ordered` — a CRTP mixin from Boost.Operators that derived the remaining operators from `==` and `<`. It worked, but it meant pulling in a dependency and adding an inheritance layer purely to get comparison operators — often considered too invasive for low-overhead systems code.

There was a second, less obvious problem: `bool` as a return type carries no information about the _nature_ of the comparison. Is `"ABC" == "abc"` under a case-insensitive comparison really "identical," or merely "equivalent"? And what about `NaN` — `1.0 < NaN` and `1.0 > NaN` are both `false`, but that doesn't mean they're equal. The old world had no vocabulary in the type system to express that distinction.

## The fix: `<=>`

C++20 introduces the three-way comparison operator — the "spaceship operator." One definition, and the rest is generated for you:

```cpp
struct Point {
    int x, y;
    auto operator<=>(const Point&) const = default;
};

static_assert(Point{1, 2} < Point{1, 3}); // compiles, with no operator< in sight
```

The key difference is the return type. `<=>` doesn't return `bool` — it returns a value from one of three comparison categories defined in `<compare>`:

- **`std::strong_ordering`** — a total order, where "equal" genuinely means substitutable: if `a == b`, the two can stand in for each other in any context without observable difference.
- **`std::weak_ordering`** — an order exists, but "equivalent" does not mean "identical." A case-insensitive string comparison is the textbook example.
- **`std::partial_ordering`** — allows for incomparability via a fourth value, `unordered`. This is the category `float`/`double` fall into, because `NaN` breaks total ordering.

A stronger category converts implicitly to a weaker one, never the reverse — which makes sense: if you know something is fully ordered, it's certainly also weakly ordered, but not vice versa. Results compare against the literal `0`:

```cpp
auto c = a <=> b;
if (c < 0)  { /* a precedes b */ }
if (c == 0) { /* equal / equivalent */ }
if (c > 0)  { /* a follows b */ }
```

## How the compiler synthesizes the rest

This isn't a macro or source-level code generation — it's a change to overload resolution itself. For `a < b`, when no direct `operator<` exists, the compiler tries the candidate `(a <=> b) < 0`, and, if that doesn't compile, also tries the reversed form `0 < (b <=> a)`. The same rewriting applies to `<=`, `>`, `>=`. For `==`/`!=`, a related but separate mechanism applies: `a != b` can rewrite to `!(a == b)`, and `a == b` can use the symmetric `b == a` when needed.

Because this all happens during overload resolution, there is zero runtime overhead versus hand-written operators — after inlining, the generated machine code for `a < b` via `(a <=> b) < 0` is identical to a manually written `operator<`.

**The one-line case:** if `operator<=>` is declared with `= default`, the compiler implicitly declares a matching `operator==` for you — you don't write it, and it still works:

```cpp
struct Foo {
    int x;
    auto operator<=>(const Foo&) const = default; // this alone is enough
};

bool same = Foo{1} == Foo{1}; // compiles — == was generated implicitly
```

This is a real, separate rule, not just the `<`/`<=`/`>`/`>=` rewriting described above: whenever a class has no user-declared `operator==` at all, the compiler implicitly declares one _for every defaulted `operator<=>`_ in that class, doing the same member-wise comparison, with the return type fixed to `bool`. So the single-line `Point` and `Version` examples earlier in this post were already complete — no second line was needed for `==` to work.

**The actual trap:** this implicit generation is tied specifically to `operator<=>` being _defaulted_. The moment you write `<=>` by hand — a custom body instead of `= default` — the implicit `==` stops being generated, and `a == b` fails to compile unless you add `operator==` yourself:

```cpp
struct Version {
    int major, minor, patch;

    std::strong_ordering operator<=>(const Version& o) const { // hand-written, not defaulted
        if (auto c = major <=> o.major; c != 0) return c;
        if (auto c = minor <=> o.minor; c != 0) return c;
        return patch <=> o.patch;
    }
    // no operator== declared -> a == b does NOT compile
};
```

The rule to actually remember: **defaulted `<=>` gives you `==` for free; hand-written `<=>` does not.** Mixing the two up — assuming a custom `<=>` body behaves like a defaulted one — is the mistake that bites people, not the reverse.

## When it still makes sense to write `operator==` yourself

Given the rule above, writing out `bool operator==(...) const = default;` next to an already-defaulted `<=>` is, strictly speaking, redundant — some static analyzers flag it exactly that way, as an unnecessary line that duplicates what the compiler already generates. There are, however, two legitimate reasons to write `operator==` explicitly:

1. **`<=>` is hand-written, not defaulted.** As shown above, this is the case where `==` genuinely needs its own definition — most naturally also `= default`, since member-wise equality is usually still what you want even when the ordering logic is custom.
2. **You want `==` to be cheaper than the full ordering, even with a defaulted `<=>`.** The implicit `==` from a defaulted `<=>` still does a member-wise comparison — correct, but not necessarily the fastest check available. A type that can decide inequality early — comparing a container's size before its contents, or a cheap hash before an expensive payload — benefits from a hand-written `operator==` that short-circuits, overriding the implicit one:

```cpp
struct Payload {
    std::vector<uint8_t> data;
    auto operator<=>(const Payload&) const = default; // still provides <, <=, >, >=
    bool operator==(const Payload& o) const {           // overrides the implicit ==
        return data.size() == o.data.size() &&           // cheap check first
               data == o.data;
    }
};
```

Outside these two cases, the single `auto operator<=>(...) const = default;` line is the complete, idiomatic answer, and adding `operator==` next to it buys nothing.

## Before and after: the same type, both eras

Here is one type, `Version`, implemented twice — first the pre-C++20 way, with all six operators hand-written, then the C++20 equivalent that behaves identically. This is the comparison that matters in practice, not the toy `Point` example above.

**Pre-C++20:**

```cpp
struct Version {
    int major, minor, patch;

    bool operator==(const Version& o) const {
        return major == o.major && minor == o.minor && patch == o.patch;
    }
    bool operator!=(const Version& o) const {
        return !(*this == o);
    }
    bool operator<(const Version& o) const {
        if (major != o.major) return major < o.major;
        if (minor != o.minor) return minor < o.minor;
        return patch < o.patch;
    }
    bool operator>(const Version& o) const {
        return o < *this;
    }
    bool operator<=(const Version& o) const {
        return !(o < *this);
    }
    bool operator>=(const Version& o) const {
        return !(*this < o);
    }
};
```

**C++20 equivalent:**

```cpp
struct Version {
    int major, minor, patch;
    auto operator<=>(const Version&) const = default;
};
```

One line. These two versions are behaviorally equivalent for every comparison — `==`, `!=`, `<`, `<=`, `>`, `>=` all work on the C++20 side, even though only `<=>` was written. Here's the operator-by-operator mapping, so it's explicit what replaced what:

| Old, hand-written | How it's obtained in C++20                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator==`      | implicitly declared by the compiler because `operator<=>` is defaulted — member-wise `major == o.major && minor == o.minor && patch == o.patch`, no source line needed |
| `operator!=`      | rewritten by the compiler to `!(a == b)`, using the implicit `==` above                                                                                                |
| `operator<`       | from the defaulted `<=>` — compiler generates member-wise `<=>` (major, then minor, then patch); `a < b` rewrites to `(a <=> b) < 0`                                   |
| `operator>`       | rewritten to `(a <=> b) > 0`, trying the reversed candidate if needed                                                                                                  |
| `operator<=`      | rewritten to `(a <=> b) <= 0`                                                                                                                                          |
| `operator>=`      | rewritten to `(a <=> b) >= 0`                                                                                                                                          |

All six of the old operators disappear entirely from the source — they still exist, callable exactly as before, but the compiler synthesizes every one of them (including `==`, via the implicit-declaration rule) from a single defaulted `<=>`. That's the actual production pattern: one `auto operator<=>(...) const = default;` line for an ordinary value type, and nothing else, unless one of the two cases from the section above applies (a custom `<=>` body, or a hand-optimized `==`). Both the pre-C++20 and the C++20 `Version` above agree that `Version{1, 2, 0} < Version{1, 3, 0}` — `major` ties, `minor` decides — through entirely different mechanisms: six independent function bodies on one side, one generated three-way comparison on the other.

### What `auto` actually deduces

When you write `auto operator<=>(...) const = default;`, the compiler works out the _common comparison type_ across every member being compared — the weakest category among them. This has a concrete, easy-to-miss consequence:

```cpp
struct Frame {
    int64_t pts;
    double  confidence; // partial_ordering — NaN is representable
    auto operator<=>(const Frame&) const = default; // whole struct -> partial_ordering
};
```

A single `double` field pulls the entire struct down to `partial_ordering`, even though `pts` on its own would give `strong_ordering`. That's not a cosmetic detail: a type with `partial_ordering` doesn't formally satisfy the _strict weak ordering_ that `std::sort` requires. If `NaN` shows up in that field at runtime, sorting is undefined behavior. In anything touching frame timing, this is worth internalizing directly: keep PTS/DTS as `int64_t`, not `double`, and be deliberate about which floating-point fields participate in `<=>` at all.

### Bases participate too

`= default` walks base classes before members, in declaration order:

```cpp
struct Base {
    int id;
    auto operator<=>(const Base&) const = default;
};

struct Derived : Base {
    int extra;
    auto operator<=>(const Derived&) const = default; // Base::id first, then extra
};
```

## Writing `<=>` by hand

When comparison logic isn't a plain member-wise walk, you write `<=>` manually — the same shape as the old `operator<`, but returning a category instead of `bool`:

```cpp
#include <compare>

struct Version {
    int major, minor, patch;

    std::strong_ordering operator<=>(const Version& o) const {
        if (auto c = major <=> o.major; c != 0) return c;
        if (auto c = minor <=> o.minor; c != 0) return c;
        return patch <=> o.patch;
    }
    bool operator==(const Version&) const = default; // required here — <=> is hand-written, not defaulted
};
```

The `if (auto c = ...; c != 0) return c;` pattern is the new idiom for multi-field comparisons — considerably more readable than the nested `if`/`else` chains this used to require. And because this `<=>` has a custom body instead of `= default`, the implicit-`==` rule from the earlier section doesn't apply — `operator==` has to be declared explicitly, or `a == b` won't compile.

## Heterogeneous comparisons, almost for free

The rewriting rules also cover comparisons between different types, without needing to hand-write the reversed overload:

```cpp
struct Meters { double value; auto operator<=>(const Meters&) const = default; };

struct Centimeters {
    double value;
    std::partial_ordering operator<=>(const Meters& m) const {
        return (value / 100.0) <=> m.value;
    }
    bool operator==(const Meters& m) const { return (*this <=> m) == 0; }
};
```

`Meters{} < Centimeters{}` works automatically via the reversed-candidate lookup — in the pre-C++20 world this required a second, manually written overload.

## Standard containers inherit it

`std::vector`, `std::pair`, `std::tuple`, `std::optional`, and `std::string` all support `<=>` in C++20 — for `std::vector<T>`, the comparison is lexicographic under the hood, built on `std::lexicographical_compare_three_way`. This means `= default` propagates cleanly through aggregate hierarchies:

```cpp
struct Frame {
    int64_t pts;
    std::vector<uint8_t> payload;
    auto operator<=>(const Frame&) const = default; // pts, then payload lexicographically
                                                      // -> also gives == implicitly
};
```

## Constraining generic code

`<concepts>` ships ready-made concepts for algorithms that need a specific ordering guarantee:

```cpp
#include <concepts>

template <std::three_way_comparable T>
void sort_something(std::vector<T>& v) { /* ... */ }

template <std::totally_ordered T>
T clamp(T v, T lo, T hi) { /* ... */ }
```

`std::three_way_comparable<T>` checks that `T` has a working `<=>`; `std::totally_ordered<T>` checks the full relational set regardless of whether it originates from `<=>` or from hand-written operators.

## Old vs. new, side by side

| Aspect                           | Before C++20                                           | C++20 (`<=>`)                                                                                 |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Operators to write               | 6 by hand, or 2 + Boost/CRTP                           | 1 defaulted `<=>` (plus `==` only for a custom `<=>` body or a hand-optimized equality check) |
| Return type                      | `bool`                                                 | ordering category                                                                             |
| Standard-library autogeneration  | none in practice (`std::rel_ops` existed, went unused) | `= default`                                                                                   |
| "Equal" vs. "equivalent"         | no distinction                                         | explicit (`strong` vs. `weak`)                                                                |
| Incomparability (NaN)            | implicit, easy to get wrong                            | explicit (`partial_ordering::unordered`)                                                      |
| Heterogeneous comparisons        | manual overloads in both directions                    | automatic via rewriting                                                                       |
| Risk of operators drifting apart | high                                                   | none — single source of truth                                                                 |

## Takeaways

`<=>` isn't cosmetic — it closes a gap that quietly produced bugs for twenty years. Two things are worth keeping in mind going forward: a defaulted `<=>` already gives you `==` for free, so writing both lines for an ordinary value type is redundant — write `operator==` explicitly only when `<=>` has a custom body or when equality needs its own, cheaper implementation. And a single floating-point member is enough to demote an entire struct's comparison category to `partial_ordering`, with real consequences for anything that later gets handed to `std::sort`.
