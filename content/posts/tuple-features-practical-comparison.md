+++ 
draft = false
date = 2026-08-21T09:17:27+02:00
title = "std::tuple features - Practical comparison"
tags = ["C++", "std::tuple", "std::pair", "piecewise-construct", "forward-as-tuple"]
categories = ["C++"]
+++

The `<tuple>` header hides a small family of utilities that look superficially similar — they all traffic in `std::tuple`, they all show up in "modern C++" checklists, and they're often name-dropped together without much explanation of what actually distinguishes them. In reality, `std::forward_as_tuple`, `std::piecewise_construct`, `std::tie`, and `std::tuple_cat` solve four genuinely different problems, and mixing them up tends to produce code that either doesn't compile, compiles but silently copies things you meant to move, or compiles and moves things you meant to keep alive.

This article walks through each one individually, in enough depth to use them correctly, and then puts them side by side so the differences are impossible to forget.

## 1. Background: `std::tuple_size` and `std::get`

Everything below assumes familiarity with the two building blocks that make `std::tuple` usable at all.

`std::get<N>(t)` retrieves the N-th element of a tuple, where `N` is a compile-time constant — this is a template non-type parameter, not a runtime index, so `std::get` cannot be called with a variable index without additional metaprogramming (e.g., `std::apply` or a manual index-based dispatch).

```cpp
#include <tuple>
#include <string>
#include <iostream>

std::tuple<int, std::string, double> t{42, "hello", 3.14};

std::cout << std::get<0>(t) << " " << std::get<1>(t) << " " << std::get<2>(t) << "\n";
// 42 hello 3.14

std::get<0>(t) = 100; // std::get returns a reference into the tuple, so this mutates t
```

`std::get` is overloaded to return the correct reference qualification based on how you call it: call it on an lvalue tuple and you get `T&`; on a `const` tuple you get `const T&`; on an rvalue (a temporary, or something you `std::move`d) you get `T&&`. This reference-forwarding behavior is exactly what makes `std::tuple` composable with move semantics, and it's the same underlying mechanism that `std::tie`, `std::forward_as_tuple`, and structured bindings all build on top of.

`std::tuple_size<T>::value` (or the C++17 variable template `std::tuple_size_v<T>`) gives you the number of elements in a tuple type, at compile time:

```cpp
using MyTuple = std::tuple<int, std::string, double>;
static_assert(std::tuple_size_v<MyTuple> == 3);
```

There's a companion trait, `std::tuple_element_t<N, T>`, that gives you the type of the N-th element:

```cpp
static_assert(std::is_same_v<std::tuple_element_t<1, MyTuple>, std::string>);
```

These two — `tuple_size` and `tuple_element` — are the traits that let generic code iterate over or reason about tuples without knowing their contents ahead of time; they're also what any type has to specialize to participate in structured bindings (`auto [a, b] = my_custom_type;`), which is why you'll see them referenced in the context of writing your own tuple-like types, not just `std::tuple` itself.

With that foundation in place, on to the four main utilities.

## 2. `std::forward_as_tuple`: Building a Tuple of References Without Copying

`std::forward_as_tuple(args...)` constructs a `std::tuple` whose element types are exactly the forwarding-reference types of its arguments — `T&&` for each argument, deduced the same way a forwarding reference parameter would deduce. Critically, **it does not copy or move anything**; it just packages references.

```cpp
#include <tuple>
#include <string>
#include <iostream>

int x = 1;
double y = 2.5;
std::string s = "hi";

auto t = std::forward_as_tuple(x, y, std::string("temporary"));
// deduced type: std::tuple<int&, double&, std::string&&>
```

Note the mixed reference types: `x` and `y` are lvalues, so they deduce to `int&` and `double&` — genuine references into the original variables, no copy. The temporary `std::string("temporary")` is an rvalue, so it deduces to `std::string&&` — a reference to the temporary, which is only valid as long as that temporary's lifetime lasts (typically, the full expression).

This makes `std::forward_as_tuple` fundamentally a **plumbing** tool — it exists to pass a bundle of arguments through some intermediate layer (typically another tuple, or a function taking a tuple) without paying for a copy or triggering an unwanted move at the point of packaging. It's rarely useful standalone; its main job is enabling the next section.

### 2.1 What it is not

It's tempting to think `std::forward_as_tuple` is just "the perfect-forwarding version of `std::make_tuple`." That's close but slightly misleading — `std::make_tuple` decays its arguments (strips references, decays arrays/functions to pointers, similar to `auto` deduction rules from the earlier article on return type deduction), producing a tuple of _values_:

```cpp
auto by_value = std::make_tuple(x, y, std::string("temporary"));
// deduced type: std::tuple<int, double, std::string> -- copies made
```

`std::forward_as_tuple`, by contrast, never decays and never copies — every element is a reference. This means the resulting tuple's validity is bound entirely to the lifetime of whatever it references, which is the central thing to keep in mind whenever you use it: **a tuple built by `forward_as_tuple` should be consumed immediately, in the same full expression, not stored.**

## 3. `std::piecewise_construct`: In-Place Construction of `std::pair` Members

This is the canonical use case that makes `std::forward_as_tuple` worth learning. `std::pair` (and by extension `std::map`, `std::unordered_map`, and any container storing pairs) has a constructor overload:

```cpp
pair(std::piecewise_construct_t, std::tuple<Args1...> first_args, std::tuple<Args2...> second_args);
```

`std::piecewise_construct` is a tag object (of type `std::piecewise_construct_t`) that selects this overload. Its purpose: construct `pair::first` and `pair::second` **in place**, directly from constructor arguments, without ever materializing a temporary `first` or `second` object and then copying or moving it into the pair.

### 3.1 The problem it solves

Consider a `std::pair` whose second member is expensive to copy and explicitly non-copyable — a common situation with RAII wrapper types, mutex-holding types, or anything modeling a unique resource:

```cpp
#include <string>
#include <utility>

struct ExpensiveResource {
    std::string data;
    ExpensiveResource(std::string d) : data(std::move(d)) {}
    ExpensiveResource(const ExpensiveResource&) = delete;
    ExpensiveResource(ExpensiveResource&&) = default;
};
```

Without `piecewise_construct`, constructing a `pair<std::string, ExpensiveResource>` requires you to already have an `ExpensiveResource` object to hand to the pair's constructor — and since it's non-copyable, you'd have to move one in, meaning you still had to construct it as a separate step first:

```cpp
ExpensiveResource r("payload");
std::pair<std::string, ExpensiveResource> p("key", std::move(r)); // fine, but requires a named temporary first
```

That's often workable, but it breaks down entirely for container `emplace`-style construction where you want to build the pair's members from raw constructor arguments in one shot, with no intermediate named object at all:

```cpp
#include <map>

std::map<std::string, ExpensiveResource> m;

m.emplace(std::piecewise_construct,
          std::forward_as_tuple("key"),
          std::forward_as_tuple("payload"));
```

Here, `std::forward_as_tuple("key")` packages the argument(s) for constructing `first` (`std::string`), and `std::forward_as_tuple("payload")` packages the argument(s) for constructing `second` (`ExpensiveResource`). The pair's piecewise constructor unpacks each tuple and forwards the arguments directly into `first`'s and `second`'s constructors, in place, inside the map's already-allocated node storage. No `ExpensiveResource` temporary is ever created and then moved — it's constructed exactly once, directly where it will live.

It's worth being precise about what "no intermediate named object" actually buys you, because a similar-looking, unnamed-temporary version is often mistaken for equally cheap:

```cpp
std::pair<std::string, ExpensiveResource> p("key", ExpensiveResource{"payload"});
```

This compiles — `ExpensiveResource` has a move constructor, even though its copy constructor is deleted — but it does strictly more work than the piecewise version. `ExpensiveResource{"payload"}` first constructs a genuine, complete temporary object; the pair's constructor then move-constructs `p.second` _from_ that temporary. Instrumenting the constructors makes this concrete:

```cpp
struct ExpensiveResource {
    std::string data;
    ExpensiveResource(std::string d) : data(std::move(d)) { std::cout << "ctor\n"; }
    ExpensiveResource(const ExpensiveResource&) = delete;
    ExpensiveResource(ExpensiveResource&& other) noexcept : data(std::move(other.data)) { std::cout << "move ctor\n"; }
};

// direct construction with a temporary:
std::pair<std::string, ExpensiveResource> p("key", ExpensiveResource{"payload"});
// prints:
//   ctor
//   move ctor

// piecewise_construct:
std::pair<std::string, ExpensiveResource> p2(std::piecewise_construct,
                                              std::forward_as_tuple("key2"),
                                              std::forward_as_tuple("payload2"));
// prints:
//   ctor
```

Same observable end state, one fewer constructor call along the way. For `ExpensiveResource` as written — a thin wrapper around a `std::string` — that extra move is cheap, but it's not free, and `std::string`'s move constructor is about as inexpensive as a move gets. The gap widens for types whose move constructor does real work (multiple heap-owned members, a `std::vector` of non-trivial elements, anything that has to touch several allocations during the move), and it becomes a hard blocker rather than an inefficiency for types that have **no** move constructor at all — an aggregate holding a `std::mutex`, for instance, or any type that's explicitly move-disabled to model a genuinely unique, immovable resource. In that case, the temporary-based construction above doesn't just cost more, it doesn't compile — `std::piecewise_construct` stops being an optimization and becomes the only way to get the object into the pair at all.

### 3.2 Why this matters even for movable types

Even when a type _is_ movable, piecewise construction can still avoid a move that a naive approach wouldn't:

```cpp
struct Point {
    int x, y;
    Point(int x_, int y_) : x(x_), y(y_) {}
};

std::map<int, Point> m;

// Piecewise: Point is constructed directly in the map's node, exactly once.
m.emplace(std::piecewise_construct,
          std::forward_as_tuple(1),
          std::forward_as_tuple(10, 20));

// Naive emplace: a Point temporary is constructed, then moved into the node.
m.emplace(1, Point(10, 20));
```

For a `Point` with two `int`s, the move is essentially free, and this distinction is academic. But scale `Point` up to something with a `std::vector` member, several strings, or anything else where "moved-from" still means "ran a constructor and a destructor," and the difference between one construction versus one construction-plus-one-move becomes real, measurable work — the more expensive the type's move constructor, the bigger the win from skipping it entirely.

### 3.3 A common mistake: forgetting `forward_as_tuple`

`piecewise_construct` requires its arguments to be `std::tuple`s specifically — passing raw arguments directly won't compile, and this is a frequent point of confusion for people encountering the idiom for the first time:

```cpp
// WRONG — won't compile: the pair constructor expects tuples, not raw args
std::pair<std::string, Point> p(std::piecewise_construct, "key", 10, 20);

// CORRECT
std::pair<std::string, Point> p(std::piecewise_construct,
                                 std::forward_as_tuple("key"),
                                 std::forward_as_tuple(10, 20));
```

`std::make_tuple` also works here in place of `std::forward_as_tuple`, but it defeats part of the purpose — it copies/decays its arguments into the intermediate tuple before that tuple's contents get forwarded onward. For anything beyond trivially-copyable scalars, `std::forward_as_tuple` is the right choice specifically because it avoids that intermediate copy.

## 4. `std::tie`: Unpacking, Assignment, and Lexicographic Comparison

`std::tie(args...)` constructs a `std::tuple` of **lvalue references** to its arguments — always `T&`, never `T&&`, regardless of what you pass (unlike `forward_as_tuple`, which preserves value category). This makes `std::tie` fundamentally about _assigning into_ existing variables, not packaging arguments for construction.

### 4.1 Unpacking a tuple or pair into existing variables

This was the idiomatic way to "destructure" a `tuple`/`pair` before C++17 structured bindings existed, and it's still the right tool when you need to assign into variables that **already exist** (structured bindings, by contrast, always introduce new variables):

```cpp
#include <tuple>
#include <utility>
#include <iostream>

std::pair<int, double> compute() { return {3, 4.5}; }

int main() {
    int a;
    double b;
    std::tie(a, b) = compute(); // assigns into existing a, b
    std::cout << a << " " << b << "\n"; // 3 4.5
}
```

`std::tie(a, b)` produces `std::tuple<int&, double&>`. Assigning `compute()`'s result (a `std::pair<int, double>`) into that tuple of references works because `std::tuple` and `std::pair` have a compatible cross-type assignment operator — the pair's elements get assigned, member-wise, into whatever `a` and `b` reference.

### 4.2 `std::ignore` for discarding specific elements

When you only care about some elements of a multi-element tuple, `std::tie` combined with the sentinel `std::ignore` lets you skip the ones you don't need, without declaring a throwaway variable for them:

```cpp
#include <tuple>
#include <string>
#include <iostream>

std::tuple<int, std::string, double> get_record();

int main() {
    int id;
    double score;
    std::tie(id, std::ignore, score) = get_record(); // name is discarded
    std::cout << id << " " << score << "\n";
}
```

`std::ignore` is a special object whose assignment operator does nothing — assigning any value to it is a silent no-op. This is purely a `std::tie`-era idiom; with structured bindings you'd instead bind a name you simply don't use, or in C++26 with the `_` placeholder proposal (not yet universally available at the time of writing), an actual anonymous discard.

### 4.3 Lexicographic comparison

A genuinely elegant, still-current use of `std::tie` — one that structured bindings don't replace — is building a multi-field comparison operator without hand-writing the cascading `if` chain:

```cpp
#include <tuple>
#include <string>

struct Employee {
    int department_id;
    std::string last_name;
    double salary;

    bool operator<(const Employee& other) const {
        return std::tie(department_id, last_name, salary)
             < std::tie(other.department_id, other.last_name, other.salary);
    }
};
```

`std::tuple`'s relational operators are defined lexicographically — compare the first elements; if they differ, that's the result; if they're equal, move to the second element; and so on. Writing this by hand for three or more fields is exactly the kind of code that's easy to get subtly wrong (a classic bug: comparing the same field twice, or forgetting a field entirely in a later refactor). `std::tie` turns a three-way cascading comparison into one expression, and because it ties _references_ rather than copies, this has no meaningful runtime overhead over the hand-written version — it typically compiles down to the same instructions.

## 5. `std::tuple_cat`: Concatenating Multiple Tuples

`std::tuple_cat(t1, t2, ..., tn)` takes any number of tuples (or tuple-like types, including `std::pair` and `std::array`) and concatenates them into a single tuple containing all of their elements, in order.

```cpp
#include <tuple>
#include <iostream>

auto t1 = std::make_tuple(1, 2.0);
auto t2 = std::make_tuple("three", 4);
auto combined = std::tuple_cat(t1, t2);
// combined: std::tuple<int, double, const char*, int>

static_assert(std::tuple_size_v<decltype(combined)> == 4);
```

Unlike `forward_as_tuple`, `tuple_cat` genuinely constructs new tuple elements — each element of the result is either copy-constructed or move-constructed from the corresponding element of an input tuple, depending on whether the input tuples were passed as lvalues or rvalues. Pass temporaries (or `std::move` your tuples in), and elements are moved; pass lvalue tuples, and elements are copied.

```cpp
auto moved_result = std::tuple_cat(std::move(t1), std::move(t2)); // elements moved out of t1, t2
```

### 5.1 Where `tuple_cat` earns its keep: variadic metaprogramming

The place `tuple_cat` is genuinely load-bearing, rather than a convenience, is variadic template code that needs to assemble argument lists incrementally — for example, building up a tuple of arguments across recursive template expansion, or flattening a tuple-of-tuples:

```cpp
#include <tuple>

template <typename... Tuples>
auto flatten(Tuples&&... tuples) {
    return std::tuple_cat(std::forward<Tuples>(tuples)...);
}

int main() {
    auto result = flatten(std::make_tuple(1, 2), std::make_tuple(3), std::make_tuple(4, 5, 6));
    // result: std::tuple<int, int, int, int, int, int>
}
```

Notice `flatten` combines two of our four utilities: it forwards its parameter pack with `std::forward`, and folds everything together with `tuple_cat`. This pattern shows up constantly in library code that builds argument lists for `std::apply`, constructs heterogeneous containers, or implements variadic factory functions.

### 5.2 The cost that's easy to overlook

Because `tuple_cat` genuinely copies or moves every element into a freshly-constructed tuple, chaining several `tuple_cat` calls (`tuple_cat(tuple_cat(a, b), c)`) can be more expensive than it looks at a glance — although a good compiler will typically fold a chain like that into a single concatenation via inlining and RVO/copy-elision for the intermediate tuple, so measure before assuming this is a bottleneck rather than assuming pessimistically. When element types are expensive to move (heap-owning types without a cheap move constructor, or types with no move constructor at all, forcing a copy), the cost is real per-element, not per-call — that's the more relevant thing to keep an eye on, not the number of `tuple_cat` invocations itself.

## 6. Where `std::tie` Does _Not_ Improve Performance — A Common Myth

It's worth being explicit about a misconception that circulates: `std::tie` for unpacking a `pair`/`tuple` is **not** a performance optimization over structured bindings, and treating it as one is a category error. Both are, at the machine-code level, typically doing the same or extremely similar work — binding names (or references) to the elements of an existing aggregate.

```cpp
// std::tie — pre-C++17 idiom, or when assigning into existing variables
int a; double b;
std::tie(a, b) = compute();

// structured bindings — C++17, introduces new variables
auto [a2, b2] = compute();
```

The actual, meaningful difference between these two is **not speed** — it's that `std::tie` assigns into variables that already exist (useful inside a loop, where you don't want to redeclare `a` and `b` on every iteration, or where you need `a` and `b` to outlive the binding and be reused later), while structured bindings always _introduce_ new variables scoped to the binding. Reach for `std::tie` when you need the "assign into existing variables" behavior specifically — not because it's faster than the alternative, because in the general case it isn't.

## 7. C++17 and Later: What Changed, and What Didn't

C++17 introduced structured bindings, which cover a large fraction of what `std::tie` used to be needed for — namely, pulling a tuple or pair apart into named pieces at the point of declaration:

```cpp
// pre-C++17
int id; std::string name; double score;
std::tie(id, name, score) = get_record();

// C++17+
auto [id, name, score] = get_record();
```

`std::apply` (also C++17) covers another chunk of what people used to hand-roll with `tuple_cat`/index sequences: calling a function with a tuple's elements as its argument list.

```cpp
#include <tuple>

auto args = std::make_tuple(1, 2.5, "three");
auto result = std::apply([](int a, double b, const char* c) {
    // ... use a, b, c
    return a;
}, args);
```

What did **not** get a replacement: `std::piecewise_construct` and `std::forward_as_tuple` remain the only standard-library-sanctioned way to construct a `pair`'s members in place from raw constructor arguments. There's no structured-bindings-era shortcut for "build these two objects, in place, inside a container node, from two separate argument lists, with zero intermediate copies or moves" — that specific problem is still solved exactly the way it was in C++11.

`std::tie`'s lexicographic-comparison use case (Section 4.3) also has no structured-bindings replacement — structured bindings only destructure, they don't build comparable proxies — so that idiom remains fully current, and you'll still see it in modern codebases, including ones that otherwise lean heavily on C++17/20 features.

## 8. Decision Table

| Utility                    | What it produces                                                       | Copies/moves elements?                                        | Primary use case                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std::forward_as_tuple`    | Tuple of forwarding references (`T&` / `T&&`, matching value category) | No — pure reference packaging                                 | Passing constructor arguments onward without materializing a temporary; almost always paired with `piecewise_construct`                                   |
| `std::piecewise_construct` | (Tag, not a tuple) selects the piecewise `pair` constructor            | N/A — enables in-place construction of `pair::first`/`second` | Constructing `pair`/map elements in place from separate constructor argument lists, avoiding a move of an otherwise-non-movable or expensive-to-move type |
| `std::tie`                 | Tuple of lvalue references (`T&`, always)                              | No — pure reference packaging                                 | Unpacking into existing variables; `std::ignore` to discard fields; lexicographic multi-field comparison                                                  |
| `std::tuple_cat`           | A brand-new tuple with concatenated elements                           | Yes — copies or moves every element into the result           | Assembling argument lists in variadic/metaprogramming code; flattening tuples of tuples                                                                   |

## 9. Summary

These four utilities cluster around `std::tuple` but serve distinct roles: `std::forward_as_tuple` is packaging, not construction — it defers the actual work to whatever consumes the tuple next. `std::piecewise_construct` is the mechanism that makes that deferred work actually happen in place, letting you construct both halves of a `pair` directly inside container storage without an intermediate object. `std::tie` is about binding existing variables to existing tuple/pair elements — for assignment, for discarding fields via `std::ignore`, or for building comparison expressions — and, in C++17 and later, competes with structured bindings for the "unpacking" use case specifically, though it remains the only option for assigning into pre-existing variables or for building comparators. `std::tuple_cat` is the odd one out in this group in that it actually does real work — copying or moving elements into a new tuple — making it the one utility here where you should actually think about the cost of the types you're concatenating, rather than assuming it's "just plumbing" like the other three.

---
