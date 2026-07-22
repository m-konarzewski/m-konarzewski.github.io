---
draft: false
date: 2026-07-18T10:00:00+02:00
title: "is_one_of in C++20: Fold expressions and concepts in practice"
tags: ["templates", "concepts", "fold-expressions", "c++20", "is_one_of"]
categories: ["C++"]
---

## Problem: the `if` that grows without end

Every C++ developer sooner or later runs into this pattern:

```cpp
if (flag == Status::Active ||
    flag == Status::Pending ||
    flag == Status::Suspended) {
    // ...
}
```

Or in a `char` / `int` version:

```cpp
if (ch == 'a' || ch == 'e' || ch == 'i' || ch == 'o' || ch == 'u') {
    // this is a vowel
}

if (code == 200 || code == 201 || code == 202 || code == 204) {
    // HTTP success
}
```

The code is correct, but it has a few drawbacks. First, it is tedious to write — each new value adds another `|| value ==`. Second, it is easy to make a copy/paste mistake and forget to change the variable name. Third, readability drops with the number of comparisons — once you have five or six alternatives, the `if` becomes hard to scan.

In other languages this problem does not exist. Python has `in`:

```python
if flag in (Status.Active, Status.Pending, Status.Suspended):
    ...
```

C++ has no built-in equivalent — but we can write one ourselves.

---

## Solution: `is_one_of`

We want a function that can be called like this:

```cpp
if (is_one_of(flag, Status::Active, Status::Pending, Status::Suspended)) {
    // ...
}
```

This requires a variadic template that accepts an arbitrary number of comparison values. The shortest correct implementation looks like this:

```cpp
template<typename Value, typename... Candidates>
constexpr bool is_one_of(const Value& value, const Candidates&... candidates) {
    return (... || (value == candidates));
}
```

The core of the function is a C++17 **fold expression**. The expression `(... || (value == candidates))` expands to:

```cpp
(value == c1) || (value == c2) || (value == c3) // etc.
```

So it behaves exactly like a manually written chain of `||`, but without repeating `value ==` for every argument. Importantly, `||` preserves **short-circuit evaluation** — once one comparison returns `true`, the remaining comparisons are not evaluated.

The function is `constexpr`, so when all arguments are known at compile time the result is computed by the compiler and there is no runtime cost:

```cpp
constexpr int x = 3;
static_assert(is_one_of(x, 1, 2, 3));   // checked at compile time
static_assert(!is_one_of(x, 4, 5, 6));
```

---

## C++20: add `requires` and make errors readable

The implementation above has one problem: if we pass a type that does not support `operator==`, the compiler will produce an error buried deep inside template instantiation. The message is long and hard to understand.

In C++20 we can fix that using `std::equality_comparable_with` from `<concepts>`:

```cpp
#include <concepts>

template<typename Value, typename... Candidates>
constexpr bool is_one_of(const Value& value, const Candidates&... candidates)
    requires (std::equality_comparable_with<Value, Candidates> && ...)
{
    return (... || (value == candidates));
}
```

The `requires` clause checks before template instantiation whether each pair `(Value, Candidate)` has a sensible `operator==`. The word "sensible" is important here — `std::equality_comparable_with<T, U>` verifies not only that `t == u` compiles, but also that the result is convertible to `bool` and that the comparison is symmetrical (`t == u` behaves like `u == t`).

### Why `requires` instead of `static_assert`?

It is possible to achieve a similar effect with `static_assert`:

```cpp
template<typename Value, typename... Candidates>
constexpr bool is_one_of(const Value& value, const Candidates&... candidates) {
    static_assert((std::equality_comparable_with<Value, Candidates> && ...),
        "Value is not comparable with one or more candidates");
    return (... || (value == candidates));
}
```

The difference is subtle but important. `static_assert` is checked inside the function body — the compiler must first instantiate the template before it sees the error. `requires` runs during **constraint checking**, before instantiation. This has two practical consequences.

First, the error appears earlier and with better context. Second, `requires` participates in **overload resolution** — you can write multiple overloaded versions of `is_one_of` with different constraints and the compiler will select the appropriate one. With `static_assert`, that is not possible because both overloads are considered equally visible.

---

## Full implementation

```cpp
#include <concepts>

template<typename Value, typename... Candidates>
constexpr bool is_one_of(const Value& value, const Candidates&... candidates)
    requires (std::equality_comparable_with<Value, Candidates> && ...)
{
    return (... || (value == candidates));
}
```

Example usage:

```cpp
// enum class
enum class Status { Active, Pending, Suspended, Banned };
Status s = Status::Pending;
is_one_of(s, Status::Active, Status::Pending);   // true

// std::string vs const char* — works because string has operator==(const char*)
std::string lang = "C++";
is_one_of(lang, "Python", "Rust", "C++");        // true

// HTTP status codes
int code = 201;
is_one_of(code, 200, 201, 202, 204);             // true

// constexpr — zero runtime cost
constexpr char ch = 'e';
static_assert(is_one_of(ch, 'a', 'e', 'i', 'o', 'u'));

// compilation error with a readable message
struct Foo {};
is_one_of(Foo{}, Foo{});   // error: equality_comparable_with not satisfied
```

---

## Summary

Three lines of code eliminate an entire class of repetitive `||` chains. A fold expression from C++17 gives a concise implementation, `constexpr` ensures zero overhead for compile-time values, and C++20 `requires` turns cryptic template errors into readable diagnostics that point directly at the unsatisfied condition.

If your project is on C++17, you can omit `requires` — the fold expression still works, but comparison errors will be reported later inside template instantiation.
