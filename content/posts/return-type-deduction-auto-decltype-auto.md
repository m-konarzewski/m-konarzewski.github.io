+++ 
draft = false
date = 2026-08-18T15:40:52+02:00
title = "Return type deduction: When to use `auto` vs `decltype(auto)`"
tags = ["C++", "auto", "decltype", "type-deduction"]
categories = ["C++"]
+++

# Return Type Deduction: When to Use `auto` vs `decltype(auto)`

C++14 gave us two ways to let the compiler deduce a function's return type: `auto` and `decltype(auto)`. On the surface they look almost interchangeable — both let you drop an explicit return type and let the compiler figure it out from the `return` statement. In practice, they follow completely different deduction rules, and picking the wrong one is a reliable way to introduce a dangling reference, silently strip `const`, or break a perfect-forwarding wrapper in a way that only shows up under `-O2` or with a specific compiler.

This article goes deep into both mechanisms, with enough examples that you should never have to guess again.

## 1. The Core Problem in One Example

Consider this pair of functions:

```cpp
#include <vector>

std::vector<int> global_vec = {1, 2, 3, 4, 5};

auto get_element_auto(std::size_t i) -> auto {
    return global_vec[i]; // operator[] returns int&
}

decltype(auto) get_element_decl(std::size_t i) {
    return global_vec[i]; // operator[] returns int&
}

int main() {
    get_element_auto(0) = 100; // ERROR: returns int by value, not an lvalue
    get_element_decl(0) = 100; // OK: returns int&, this actually mutates global_vec[0]
}
```

Same function body, same expression in the `return` statement, radically different observable behavior. `get_element_auto` returns `int` by value — you get a copy, and assigning to the call result is a compile error. `get_element_decl` returns `int&` — you get a real reference into the vector, and the assignment works.

Neither behavior is "wrong." Each is correct _for what it does_. The point of this article is to make sure you know, before you write the function, which one you're asking for.

## 2. `auto` Return Type Deduction: Template Argument Deduction Rules

When you write:

```cpp
auto foo() {
    return expr;
}
```

the compiler deduces the return type using the **same rules as template argument deduction** — essentially the same rules that apply to `auto x = expr;` for a local variable. This has several concrete consequences:

- References are stripped. `T&` and `T&&` in the type of `expr` collapse to `T`.
- Top-level `const` and `volatile` are stripped.
- Arrays and function types decay to pointers, exactly like passing an array to a function that takes it "by value."

### 2.1 Reference stripping

```cpp
int global = 42;

auto get_ref() {
    return global; // deduced type: int (not int&)
}

int& get_actual_ref() {
    return global; // explicit int&, no deduction involved
}

int main() {
    auto x = get_ref();       // x is a copy of global
    x = 100;                  // does NOT affect global

    int& r = get_actual_ref();
    r = 100;                  // DOES affect global
}
```

### 2.2 `const` stripping

```cpp
const std::string message = "immutable";

auto get_message() {
    return message; // deduced type: std::string, NOT const std::string
}

int main() {
    auto m = get_message();
    m += " but this copy isn't"; // perfectly legal, m is a plain std::string
}
```

### 2.3 Array-to-pointer decay

```cpp
auto get_array_ptr() {
    static int arr[5] = {1, 2, 3, 4, 5};
    return arr; // deduced type: int*, not int(&)[5]
}
```

This mirrors exactly what happens with `template <typename T> void f(T t)` when you call `f(arr)` — the array decays to a pointer. If you actually wanted to preserve array-ness, you'd need an explicit trailing return type like `auto get_array_ref() -> int(&)[5]`.

### 2.4 Multiple `return` statements must deduce to the same type

Unlike `decltype(auto)` (discussed below), `auto` has a straightforward consistency requirement: every `return` statement in a function using `auto` deduction must produce the _exact same deduced type_, or the program is ill-formed.

```cpp
auto pick(bool flag) {
    if (flag) {
        return 42;      // deduces int
    } else {
        return 3.14;     // ERROR: deduces double, conflicts with int
    }
}
```

```cpp
auto pick_ok(bool flag) {
    if (flag) {
        return 42;
    } else {
        return 0; // still int, fine
    }
}
```

This is a genuinely useful compiler check — it catches accidental type drift across branches that you might not notice with an explicit `auto` disguising two different numeric types.

## 3. `decltype(auto)`: `decltype(expr)` Rules

When you write:

```cpp
decltype(auto) foo() {
    return expr;
}
```

the compiler deduces the return type as if you had written `decltype(expr)` by hand. This is a **completely different rule set** from template argument deduction, and the difference matters enormously:

- References are **preserved**, not stripped.
- `const`/`volatile` are **preserved**.
- The syntactic form of `expr` matters — specifically, whether it's a plain id-expression or a parenthesized expression changes the deduced type. This is the pitfall in Section 4.

### 3.1 Preserving references

```cpp
#include <vector>

std::vector<int> data = {10, 20, 30};

decltype(auto) front_ref() {
    return data.front(); // data.front() returns int&
}

int main() {
    front_ref() = 999; // OK — genuinely mutates data[0]
}
```

Here `decltype(data.front())` is `int&`, because `.front()`'s declared return type is `int&`, and `decltype` on a function call expression yields exactly that function's return type.

### 3.2 Preserving `const` — and a caveat about scalar-by-value returns

For a class type, `decltype(auto)` genuinely preserves a `const` return-by-value:

```cpp
#include <string>

const std::string prefix = "orderid-";

decltype(auto) get_prefix() {
    return prefix; // decltype(prefix) is const std::string, since prefix is an id-expression naming a const object
}

int main() {
    decltype(auto) p = get_prefix(); // p is genuinely const std::string
    // p += "1234";                 // ERROR: p is const
}
```

For a **scalar** type, however, this does _not_ work the way you'd expect, for a subtle but important reason — and it's worth being precise about what exactly happens, because there are two different things in play that are easy to conflate.

```cpp
const int limit = 100;

decltype(auto) get_limit() {
    return limit; // decltype(limit) is const int -> the function's declared/deduced return type really is const int
}
```

First fact: the function's own _type_ genuinely includes the `const`. You can confirm this with RTTI:

```cpp
#include <cxxabi.h>
#include <cstdlib>
#include <iostream>

int status;
char* name = abi::__cxa_demangle(typeid(get_limit).name(), nullptr, nullptr, &status);
std::cout << name << '\n'; // prints: int const ()
std::free(name);
```

`get_limit`'s type really is `int const ()` — `decltype(auto)` correctly deduced `const int` as the return type, and that's genuinely part of the function's type, visible via `typeid`.

Second fact, and this is the subtle part: that `const` is functionally dead the moment you _call_ the function, because the call expression `get_limit()` is a prvalue of scalar type, and the standard specifies that a prvalue of non-class, non-array type is never cv-qualified — top-level `const`/`volatile` is stripped from the _type of the expression_ before `decltype`, template argument deduction, or anything else looks at it:

```cpp
static_assert(std::is_same_v<decltype(get_limit()), int>); // NOT const int

int main() {
    decltype(auto) y = get_limit(); // y is plain, mutable int
    y = 200;                        // compiles fine — y was never const
}
```

So both statements are simultaneously true: the function's declared type is `int const ()`, confirmed by `typeid` — and yet `decltype(get_limit())`, `decltype(auto) y = get_limit();`, and ordinary `auto` all yield plain `int`, because the call _expression_, not the function _declaration_, is what's subject to the prvalue cv-stripping rule. If you declare the return type explicitly as `const int get_limit();` instead of via `decltype(auto)`, GCC and Clang will typically warn with something like `-Wignored-qualifiers` ("type qualifiers ignored on function return type") — a hint that the qualifier is real in the type system but inert in practice for non-class return-by-value. The lesson generalizes: `decltype(auto)`'s const-preservation is real and observable for class types (Section 3.2 above), but for scalars returned by value it's a const that exists on paper and evaporates on contact with any actual use of the return value.

**Standard reference.** This isn't compiler-specific folklore — it's specified in [basic.lval] ("Value category"), paragraphs 6 and 9. Paragraph 6's note explains the mechanism: when a glvalue is used where a prvalue is required, cv-qualifiers on a non-class-typed expression are dropped as part of that conversion — which is exactly why an lvalue of type `const int` can stand in wherever a prvalue of type `int` is expected. Paragraph 9's note states the resulting rule directly: <cite index="11-9">"Class and array prvalues can have cv-qualified types; other prvalues always have cv-unqualified types,"</cite> with a further cross-reference to [expr.type] for the precise mechanics. Full text: [timsong-cpp.github.io/cppwp/n4861/basic.lval](https://timsong-cpp.github.io/cppwp/n4861/basic.lval), paragraphs 6 and 9.

That's the rule responsible for everything demonstrated above: it applies the moment `get_limit()` is evaluated as a call expression (a prvalue of scalar type), regardless of what `const`-ness is nominally recorded in the function's own declared type.

## 4. The Classic Pitfall: Parentheses Change Everything

This is the single most-cited gotcha with `decltype(auto)`, and it comes directly from how `decltype` treats its operand:

- If the operand is a plain **id-expression** (just a variable name) or a plain **class member access** without parentheses, `decltype` yields the _declared type_ of that entity.
- If the operand is **any other expression** — including a parenthesized id-expression — `decltype` yields a type based on the **value category** of the expression: an lvalue expression gives you `T&`, an xvalue gives you `T&&`, a prvalue gives you `T`.

Parentheses turn a plain variable name into "any other expression," which is an lvalue, which means `decltype` now reports a reference type, even though the identifier itself is declared as a plain non-reference value.

```cpp
decltype(auto) foo() {
    int x = 42;
    return x;    // decltype(x) -- x is an id-expression -> deduced type is int
}

decltype(auto) bar() {
    int x = 42;
    return (x);  // decltype((x)) -- parenthesized -> x used as lvalue -> deduced type is int&
}                // DANGLING REFERENCE: x is a local variable that dies when bar() returns!
```

`foo()` returns `int` — a safe copy. `bar()` looks nearly identical, differing only by two characters, and returns `int&` — a reference to a local variable's storage that no longer exists once the function returns. Calling `bar()` and reading the result is undefined behavior. No compiler diagnostic is required, and in practice most compilers will not warn you, because syntactically this is completely legal C++; the danger is purely semantic.

This single pair of examples is why many style guides (and my own recommendation, see Section 8) say: default to `auto` for return types unless you have a specific, deliberate reason to preserve reference-ness — and if you do use `decltype(auto)`, be paranoid about every parenthesis in every `return` statement.

### 4.1 A more realistic version of the same bug

```cpp
struct Widget {
    int value = 10;
};

decltype(auto) get_value_buggy(Widget w) {
    return (w.value); // parenthesized member access of a *local* parameter -> reference to dead memory
}

decltype(auto) get_value_correct(Widget w) {
    return w.value;   // plain member access -> decltype yields int -> safe copy
}
```

`w` is a parameter passed by value; it's a local object that's destroyed when the function returns. `get_value_buggy` wraps `w.value` in parentheses, which under `decltype`'s rules makes it an lvalue expression, deducing `int&` — a reference into a parameter that's already gone by the time the caller gets it.

## 5. Where `decltype(auto)` Is Genuinely Necessary: Perfect-Forwarding Wrappers

This is the motivating use case for `decltype(auto)`'s existence: writing a generic wrapper function that calls some other function and needs to forward back _exactly_ what that function returned — same type, same reference-ness, same constness — without knowing in advance what that is.

```cpp
#include <iostream>
#include <utility>

int& get_int_ref() {
    static int value = 7;
    return value;
}

int get_int_value() {
    return 42;
}

// Generic logging wrapper: must preserve whatever the wrapped
// callable actually returns.
template <typename Func, typename... Args>
decltype(auto) logging_wrapper(Func&& func, Args&&... args) {
    std::cout << "Calling wrapped function...\n";
    return std::forward<Func>(func)(std::forward<Args>(args)...);
}

int main() {
    logging_wrapper(get_int_ref) = 999; // must compile: wrapper needs to return int&
    std::cout << get_int_ref() << "\n"; // prints 999

    int v = logging_wrapper(get_int_value); // returns plain int here, also fine
}
```

If `logging_wrapper` used `auto` instead of `decltype(auto)`, the first call would silently stop compiling as an lvalue-assignable expression — `auto` would deduce `int` (stripping the reference), and `logging_wrapper(get_int_ref) = 999;` would fail to compile, because you can't assign to a temporary. Worse, if `Func` sometimes returns a reference and sometimes a value, `auto` would quietly change the semantics of the wrapper (always copying) without any compile error at all — you'd just get worse performance and lose the ability to mutate through the wrapper, with no diagnostic.

This is precisely why the standard library idiom for this kind of wrapper (before C++14 not being available yet) required a trailing-`decltype` return type — see Section 7.

### 5.1 A `std::forward`-heavy example: memoization proxy

```cpp
#include <unordered_map>
#include <string>

class Config {
    std::unordered_map<std::string, std::string> data_;
public:
    std::string& at(const std::string& key) { return data_[key]; }
    const std::string& at(const std::string& key) const { return data_.at(key); }
};

template <typename T, typename Key>
decltype(auto) access(T&& container, Key&& key) {
    // Forwards to whichever overload of at() is selected —
    // could be std::string& or const std::string&, depending on T.
    return std::forward<T>(container).at(std::forward<Key>(key));
}

int main() {
    Config cfg;
    access(cfg, std::string("name")) = "widget"; // needs a real reference to mutate cfg
}
```

`access` has no idea, at the point it's written, whether `T` will be `Config&` or `const Config&`. `decltype(auto)` correctly propagates whichever `at()` overload actually gets called — mutable reference or const reference — without the author needing to write two overloads by hand.

## 6. The Dangling Reference Trap, In Depth

Section 4 showed the parentheses trap. But `decltype(auto)` can dangle even _without_ parentheses, any time the returned expression's declared type is itself a reference to something local.

```cpp
#include <string>

decltype(auto) make_greeting_broken(const std::string& name) {
    std::string greeting = "Hello, " + name + "!";
    const std::string& ref = greeting; // ref is a reference, greeting is local
    return ref; // decltype(ref) is const std::string& -- id-expression, no parens needed to trigger this
}
```

Here there are no sneaky parentheses at all — `ref` is _declared_ as `const std::string&`, so `decltype(ref)` is `const std::string&` regardless of how you write the `return` statement. `decltype(auto)` faithfully reports that declared type, and the function returns a reference to `greeting`, a local variable that is destroyed at the end of the function. This is exactly the same class of bug as returning `int&` to a local `int` — `decltype(auto)` doesn't introduce a new kind of danger, it just makes it easier to get there _by accident_, because you're not looking at an explicit `T&` in the function signature reminding you what you promised.

Contrast with `auto`, which is dangle-proof in this specific scenario, because it always yields a value type from a reference-typed expression:

```cpp
auto make_greeting_safe(const std::string& name) {
    std::string greeting = "Hello, " + name + "!";
    const std::string& ref = greeting;
    return ref; // auto strips the reference -> deduced type std::string -> copy, safe
}
```

**Rule of thumb:** `auto` return type deduction cannot dangle from a locally-declared reference-to-local — it always copies. `decltype(auto)` can, because that's the entire point of it: it preserves whatever reference-ness the expression has, and it doesn't know or care whether the referent is about to go out of scope.

### 6.1 Structured bindings interaction

A related trap shows up when combining `decltype(auto)` with structured bindings:

```cpp
#include <tuple>

decltype(auto) get_first_broken() {
    auto [a, b] = std::make_tuple(1, 2); // a, b are local
    return (a); // parenthesized -> lvalue -> int& -> dangling
}
```

Same root cause as Section 4, just wearing a structured-bindings costume. The lesson generalizes: **any time `decltype(auto)` deduces a reference type, ask yourself what that reference refers to, and whether it outlives the function call.**

## 7. Historical Context: Trailing `decltype` Before C++14

Before C++14 introduced `decltype(auto)`, if you wanted to write a function template whose return type depended on an expression involving its own parameters, you had to use a **trailing return type** with `decltype`, because in the function's parameter scope the parameters aren't visible yet at the point where a leading return type would normally go:

```cpp
// C++11 style
template <typename T, typename U>
auto add(T t, U u) -> decltype(t + u) {
    return t + u;
}
```

The `auto` here is not doing type deduction in the C++14 sense — it's a syntactic placeholder required by the trailing-return-type grammar (`auto f() -> ReturnType`), and the actual type comes from `decltype(t + u)` referring to parameters that are now in scope because they appear after the parameter list.

C++14's `decltype(auto)` as a return type doesn't replace this trailing-return-type idiom outright, but it does let you write the equivalent forwarding-wrapper pattern (Section 5) _without_ having to spell out the expression twice — once in the trailing `decltype(...)` and again in the function body:

```cpp
// C++11 style forwarding wrapper: expression duplicated
template <typename Func, typename... Args>
auto call_and_log_cpp11(Func&& func, Args&&... args)
    -> decltype(std::forward<Func>(func)(std::forward<Args>(args)...)) {
    return std::forward<Func>(func)(std::forward<Args>(args)...);
}

// C++14 style: no duplication
template <typename Func, typename... Args>
decltype(auto) call_and_log_cpp14(Func&& func, Args&&... args) {
    return std::forward<Func>(func)(std::forward<Args>(args)...);
}
```

The C++11 version has a subtle maintenance hazard: the expression in the trailing `decltype` and the expression in the `return` statement must stay in sync by hand. If someone edits the body without updating the trailing return type (or vice versa), you get a mismatch that may or may not be caught by the compiler depending on how the types relate. `decltype(auto)` removes this duplication entirely — one source of truth.

Trailing return types with explicit `decltype` are still useful today, though, for cases where you want the deduced type documented directly in the declaration (e.g., in a header, separate from the definition) — `decltype(auto)` gives you no information at the declaration site about what's actually being returned.

## 8. Practical Decision Rules

<svg viewBox="0 0 900 620" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="var(--diagram-line, #6b7280)"/>
    </marker>
  </defs>
  <style>
    .box { fill: var(--diagram-box, #f3f4f6); stroke: var(--diagram-line, #6b7280); stroke-width: 1.5; rx: 8; }
    .decision { fill: var(--diagram-accent, #eef2ff); stroke: var(--diagram-line, #6b7280); stroke-width: 1.5; }
    .label { font-size: 14px; fill: var(--diagram-text, #111827); }
    .small { font-size: 12px; fill: var(--diagram-text, #111827); }
    .edge { stroke: var(--diagram-line, #6b7280); stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
    .edgelabel { font-size: 12px; fill: var(--diagram-line, #4b5563); }
  </style>

  <rect class="decision" x="330" y="10" width="240" height="60" />
  <text x="450" y="35" class="label" text-anchor="middle">Do callers need to</text>
  <text x="450" y="55" class="label" text-anchor="middle">mutate through the return value?</text>

  <path class="edge" d="M400,70 C350,110 300,120 260,150" />
  <text x="290" y="110" class="edgelabel">yes</text>

  <path class="edge" d="M500,70 C560,110 620,120 660,150" />
  <text x="600" y="110" class="edgelabel">no</text>

  <rect class="decision" x="120" y="150" width="280" height="60" />
  <text x="260" y="175" class="label" text-anchor="middle">Is this a generic forwarding</text>
  <text x="260" y="195" class="label" text-anchor="middle">wrapper around an unknown callable?</text>

  <path class="edge" d="M180,210 C160,250 150,260 150,290" />
  <text x="120" y="255" class="edgelabel">yes</text>

  <path class="edge" d="M340,210 C370,250 390,260 400,290" />
  <text x="380" y="255" class="edgelabel">no</text>

  <rect class="box" x="60" y="290" width="180" height="60" />
  <text x="150" y="315" class="label" text-anchor="middle">decltype(auto)</text>
  <text x="150" y="335" class="small" text-anchor="middle">preserves ref/value category</text>

  <rect class="box" x="320" y="290" width="220" height="70" />
  <text x="430" y="312" class="label" text-anchor="middle">int&amp; foo();</text>
  <text x="430" y="330" class="small" text-anchor="middle">explicit reference return type —</text>
  <text x="430" y="347" class="small" text-anchor="middle">no deduction needed at all</text>

  <rect class="decision" x="560" y="150" width="280" height="60" />
  <text x="700" y="175" class="label" text-anchor="middle">Does the function body have</text>
  <text x="700" y="195" class="label" text-anchor="middle">multiple, differently-typed returns?</text>

  <path class="edge" d="M640,210 C610,250 590,260 590,290" />
  <text x="560" y="255" class="edgelabel">no</text>

  <path class="edge" d="M780,210 C810,250 820,260 820,290" />
  <text x="800" y="255" class="edgelabel">yes</text>

  <rect class="box" x="500" y="290" width="180" height="60" />
  <text x="590" y="315" class="label" text-anchor="middle">auto</text>
  <text x="590" y="335" class="small" text-anchor="middle">safe default, no dangling</text>

  <rect class="box" x="730" y="290" width="200" height="80" />
  <text x="830" y="312" class="label" text-anchor="middle">std::variant&lt;...&gt;</text>
  <text x="830" y="330" class="small" text-anchor="middle">or common base type,</text>
  <text x="830" y="348" class="small" text-anchor="middle">explicit return type —</text>
  <text x="830" y="365" class="small" text-anchor="middle">auto can't unify branches</text>

  <rect class="box" x="30" y="420" width="840" height="130" fill="var(--diagram-box, #f9fafb)" />
  <text x="450" y="445" class="label" text-anchor="middle" font-weight="bold">Rule of thumb</text>
  <text x="450" y="470" class="small" text-anchor="middle">Default to `auto`. It cannot dangle from a local reference, it strips const/refs consistently,</text>
  <text x="450" y="488" class="small" text-anchor="middle">and the compiler enforces that every branch agrees on a type.</text>
  <text x="450" y="510" class="small" text-anchor="middle">Reach for `decltype(auto)` only when you deliberately need to preserve reference-ness —</text>
  <text x="450" y="528" class="small" text-anchor="middle">almost always in a generic forwarding wrapper — and audit every `return` for stray parentheses.</text>
</svg>

### 8.1 Summary heuristics

- **Default to `auto`.** It's the safer choice: it can never dangle a reference to a local, it strips `const` and reference-ness consistently, and the compiler rejects mismatched types across multiple `return` statements.
- **Reach for `decltype(auto)`** specifically when writing a generic pass-through / forwarding wrapper (logging, timing, memoizing, retrying) around a callable whose return type — value, `T&`, or `const T&` — you don't know ahead of time and must preserve exactly.
- **Never use `decltype(auto)` casually** "just in case" — every additional `return` statement is a fresh opportunity for the parenthesization trap from Section 4.
- **If a function has an explicit, known reference return type**, just write it explicitly (`int& foo();`) instead of relying on deduction at all. Deduction is for when the type is genuinely dependent on template parameters or otherwise non-obvious; it's not a style preference for ordinary functions.
- **If branches return genuinely different types**, neither `auto` nor `decltype(auto)` unifies them — you need an explicit common type, `std::variant`, or a base-class pointer/reference.

## 9. Comparison Table

| Aspect                            | `auto`                                              | `decltype(auto)`                                                                               |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Deduction rule basis              | Template argument deduction (like `auto x = expr;`) | `decltype(expr)` rules                                                                         |
| References in `expr`'s type       | Stripped                                            | Preserved                                                                                      |
| `const`/`volatile` (top-level)    | Stripped                                            | Preserved                                                                                      |
| Arrays / functions                | Decay to pointer                                    | Preserved as array/function type if `expr` is an id-expression                                 |
| Sensitive to parentheses          | No                                                  | **Yes** — `return x;` vs `return (x);` can deduce different types                              |
| Can dangle from a local reference | No (always copies)                                  | Yes, if the deduced type is a reference                                                        |
| Multiple `return` statements      | Must all deduce to the identical type               | Must all deduce to the identical type (same rule, different deduction mechanism per statement) |
| Typical use case                  | General-purpose default; most functions             | Generic forwarding wrappers preserving exact return semantics                                  |
| Pre-C++14 equivalent              | N/A (new in C++14 for functions)                    | Trailing `-> decltype(expr)`                                                                   |

## 10. Closing Thoughts

`auto` and `decltype(auto)` are not two flavors of "let the compiler figure it out" — they encode two different philosophies about what a return type deduction should optimize for. `auto` optimizes for safety and simplicity: you get a value, full stop, and the compiler stops you if your branches disagree. `decltype(auto)` optimizes for fidelity: you get _exactly_ the type and value category of the expression you wrote, parentheses and all, which is exactly what a forwarding wrapper needs and exactly what makes it easy to shoot yourself in the foot everywhere else.

If you take one thing away from this article: reach for `decltype(auto)` when you have a specific, articulable reason tied to reference/value-category preservation — not as a "more powerful `auto`." In every other case, `auto` is not just simpler, it's structurally safer.

---
