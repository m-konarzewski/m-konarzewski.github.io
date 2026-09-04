+++ 
draft = false
date = 2026-09-03T11:00:30+02:00
title = "constexpr vs consteval vs constinit: Compile-Time Guarantees in C++20/23/26"
tags = ["constexpr", "consteval", "constinit"]
categories = ["C++"]
+++

Three keywords, three questions, three completely different jobs:

- `constexpr` → "**Can** this run at compile time? If not, fine, run it at runtime."
- `consteval` → "This **must** run at compile time. If it can't, that's a compile error."
- `constinit` → "This variable's **initial value** must be ready before the program starts running — but you can still change it afterward."

That's the whole article in three lines. Everything below is examples, because the theory alone doesn't tell you when to reach for which one — the examples do.

## 1. `constexpr` — your default choice for "compute this once, use it everywhere"

### Example: a compile-time constant instead of a magic number

```cpp
constexpr int MAX_PLAYERS = 4;
constexpr double PI = 3.14159265358979;

std::array<Player, MAX_PLAYERS> players; // array size needs a compile-time constant —
                                          // a plain `const int` from a non-constant
                                          // initializer wouldn't work here
```

This is the single most common use of `constexpr` you'll write: replacing `#define MAX_PLAYERS 4` with something that's actually type-checked and scoped.

### Example: a small compile-time-capable helper function

```cpp
constexpr int square(int x) {
    return x * x;
}

constexpr int a = square(5);   // computed at compile time — baked into the binary as 25
int user_input = get_input();
int b = square(user_input);    // computed at runtime — and that's totally fine
```

Same function, two different behaviors depending on how you call it. That's the whole point of `constexpr` on a function: it doesn't force compile time, it just _allows_ it.

**When do you actually reach for this?** Whenever you're writing a small, pure function (no I/O, no global state) and there's a decent chance someone will want to use its result as a compile-time constant somewhere — an array size, a `static_assert`, a template argument. If nobody will ever need that, a plain function is fine too; `constexpr` doesn't cost you anything to add, so it's a cheap habit to build.

### Example: array sizes and lookup tables computed at compile time

```cpp
constexpr int factorial(int n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}

constexpr int FACTORIAL_5 = factorial(5); // 120, computed by the compiler, zero runtime cost

constexpr std::array<int, 10> make_squares() {
    std::array<int, 10> result{};
    for (int i = 0; i < 10; ++i) {
        result[i] = i * i;
    }
    return result;
}

constexpr std::array<int, 10> squares = make_squares(); // whole table baked in at compile time
```

This is a genuinely common pattern in real codebases: precomputing a lookup table so the _program's startup_ doesn't pay for it — the values just exist in the binary. Loops, local variables, and even `std::array` manipulation inside `constexpr` functions have been legal since C++14/C++20, so this reads like ordinary code.

### Example: `constexpr` in classes — compile-time-friendly constructors

```cpp
class Point {
public:
    constexpr Point(double x, double y) : x_(x), y_(y) {}
    constexpr double x() const { return x_; }
    constexpr double y() const { return y_; }
private:
    double x_, y_;
};

constexpr Point origin(0.0, 0.0); // built entirely at compile time, no runtime constructor call
```

This shows up whenever you're modeling small value types (points, colors, durations, currency amounts) — marking the constructor and accessors `constexpr` costs nothing and lets callers build compile-time instances when they want to, while ordinary runtime construction still works exactly as before.

### Example: `if consteval` — behaving differently at compile time vs runtime (C++23)

```cpp
#include <cmath>

constexpr double compute_sqrt(double x) {
    if consteval {
        // compile-time path: no access to runtime math library intrinsics,
        // so use a simple iterative approximation
        double guess = x;
        for (int i = 0; i < 40; ++i) {
            guess = 0.5 * (guess + x / guess);
        }
        return guess;
    } else {
        // runtime path: just call the fast, hardware-accelerated library function
        return std::sqrt(x);
    }
}
```

You won't need this often, but it's good to recognize: it lets one `constexpr` function have a "slow but constant-expression-legal" path and a "fast but runtime-only" path, and the compiler picks automatically. Before C++23, people wrote `if (std::is_constant_evaluated())` for this — functionally similar, but `if consteval` reads more clearly and avoids a few sharp edges around negating the condition. If you see `is_constant_evaluated()` in older code, that's what it's doing.

## 2. `consteval` — "this must happen at compile time, or fail loudly"

### Example: forcing a computation to never sneak into runtime

```cpp
consteval int square(int x) {
    return x * x;
}

constexpr int a = square(5);   // fine
int user_input = get_input();
int b = square(user_input);    // COMPILE ERROR — user_input isn't known at compile time,
                                // and consteval refuses to fall back to runtime
```

Compare this directly to the `constexpr square` example above — identical body, but changing `constexpr` to `consteval` turns "runtime fallback" into "hard compile error." That's the entire behavioral difference in one example.

### Example: compile-time input validation (the realistic use case)

```cpp
consteval bool is_power_of_two(unsigned n) {
    return n != 0 && (n & (n - 1)) == 0;
}

template <unsigned N>
class RingBuffer {
    static_assert(is_power_of_two(N), "RingBuffer size must be a power of two");
    // ... implementation relies on N being a power of two for fast index wrapping
};

RingBuffer<16> buffer1; // fine
RingBuffer<10> buffer2; // compile error, caught immediately — not a runtime assert,
                         // not a crash in production, a build failure
```

This is the pattern to actually remember: `consteval` shines when you want a mistake to be **impossible to ship**, not just easy to catch later. Writing a small fixed-size container class, a compile-time-checked "this string must be non-empty," or a compile-time-checked format string all fall into this bucket.

### Example: a compile-time-only "tag" type

```cpp
struct CompileTimeOnly {
    consteval CompileTimeOnly(int v) : value(v) {
        if (v < 0) {
            throw "value must be non-negative"; // triggers a compile error if this
        }                                       // constructor is ever called with
    }                                           // a negative value
    int value;
};

constexpr CompileTimeOnly a(5);   // fine
// CompileTimeOnly b(get_input()); // compile error — can't construct this
                                   // from a runtime value at all
```

Marking a constructor `consteval` means the type simply cannot be constructed at runtime, period. This is a narrower tool than the validation example above — you reach for it when a type should conceptually only ever exist as a compile-time value (tags, compile-time configuration descriptors), not for everyday value types.

### The one-line mental test for `consteval` vs `constexpr`

Ask: **"If this ran at runtime instead of compile time, would anything actually break?"**

- "No, it'd just be a normal function call, maybe slightly slower" → `constexpr`.
- "Yes — the whole reason I wrote this was to catch the problem before the program ships" → `consteval`.

## 3. `constinit` — safe startup for global/static variables that still need to change

This is the keyword juniors encounter _least_ often early on, because it's specifically about a bug pattern that mostly bites you once your codebase has multiple `.cpp` files with global state — which is exactly the phase where a lot of junior devs are just starting to run into subtle startup-order bugs for the first time. So here's the bug first, then the fix.

### The bug `constinit` exists to prevent

```cpp
// logger.cpp
Logger global_logger = create_logger(); // non-trivial construction, runs "at startup"

// config.cpp
extern Logger global_logger;
Config global_config = load_config(global_logger); // ALSO runs "at startup" —
                                                     // and reads global_logger
```

If `global_config`'s initialization runs _before_ `global_logger`'s, you're reading from an object that hasn't been constructed yet — undefined behavior, and in practice usually a crash or garbage data that's miserable to debug, because it depends on _link order_, which can silently change when you add a new source file. This is the classic "static initialization order fiasco," and it's a rite of passage bug for a lot of people the first time they hit it.

### The `constinit` fix — when it applies

`constinit` only helps when the variable's initializer _can_ be a compile-time constant expression. It doesn't fix the general case (you can't `constinit` a `Logger` built from file I/O) — but a huge fraction of real global state is simpler than that: counters, flags, small POD structs with literal initial values.

```cpp
constinit int global_request_counter = 0;  // guaranteed initialized before
                                            // any dynamic initializers run —
                                            // zero chance of order-fiasco bugs
                                            // involving this variable

void handle_request() {
    global_request_counter++; // still fully mutable — constinit is NOT const
}
```

Notice: `counter++` compiles fine. `constinit` variables are ordinary mutable variables at runtime — the guarantee is purely about _when the first value is set_, not about what happens afterward. If you tried to write `constexpr int global_request_counter = 0;` instead and then mutate it, that would fail to compile, because `constexpr` on a variable does imply constness. That's the practical difference in one sentence: **`constexpr` variable = compile-time constant, stays constant. `constinit` variable = compile-time-safe initial value, free to change.**

### Example: `thread_local` state (a very common real use)

```cpp
thread_local constinit int tls_call_depth = 0;

void recursive_function() {
    tls_call_depth++;
    if (tls_call_depth > 1000) {
        throw std::runtime_error("recursion limit hit");
    }
    // ...
    tls_call_depth--;
}
```

Per-thread counters, per-thread scratch buffers, per-thread request IDs — this is where `constinit` shows up most often in practice. Without it, a `thread_local` variable with a non-trivial initializer typically needs a runtime guard check the first time each thread touches it (that's the mechanism behind lazy-initialized thread-locals, sometimes called the "Meyers singleton" pattern applied to `thread_local`). `constinit` sidesteps that guard check entirely for the initialization step, because the compiler already proved the initial value at compile time.

### Quick "should I use `constinit` here?" checklist

- Is it a namespace-scope or `thread_local` variable? (Not a local variable inside a function — locals don't have this initialization-order problem.)
- Does it need to be **mutated** after startup? (If not, you don't need `constinit` — just use `constexpr` and get the immutability for free.)
- Can its **initial value** be computed from literals/constants alone, with no file I/O, no dependency on another global, no runtime input? (If not, `constinit` can't help — you have a genuine dynamic-initialization dependency and need a different fix, like wrapping it in a function-local static instead.)

If you answered yes/yes/yes, `constinit` is the right tool.

> **Should every global/static variable be `constinit` by default?** No. Most globals can't take it at all — the moment a variable's initializer depends on `getenv()`, file I/O, another non-`constinit` global, or basically anything beyond literals, `constinit` simply won't compile, and you need a different fix (typically a function-local `static`, which lazily initializes on first use instead of at startup). And even when it _would_ compile, it's not a reflexive default — it's a signal for one specific situation, not a general habit.
>
> A quick decision order for any given global:
>
> 1. **Can it not be global at all?** Prefer that — pass state explicitly, or wrap it in a class.
> 2. **Does it need to be mutable?** If no → `constexpr` (you get the compile-time-safe init _and_ immutability, which is strictly safer than `constinit` when you don't need mutation).
> 3. **If yes, is the initializer a constant expression?** → `constinit`.
> 4. **If yes, and the initializer isn't a constant expression?** → a function-local `static` instead of a plain global.
>
> So `constinit` is the right call specifically for "mutable, namespace-scope or `thread_local`, constant-expression initial value" — not a blanket replacement for `static` or plain globals in general.

## 4. Side-by-side: the same variable, three ways

Nothing clarifies this faster than seeing one value declared all three ways and watching what each one actually permits:

```cpp
constexpr int a = 10;   // compile-time constant, immutable
constinit int b = 10;   // compile-time-safe initial value, MUTABLE afterward
int c = 10;              // ordinary variable, no compile-time guarantee at all,
                          // and (if this were namespace-scope with a complex
                          // initializer) potentially subject to the init-order fiasco

a = 20; // COMPILE ERROR — a is const
b = 20; // fine — b is not const
c = 20; // fine — c was never const to begin with
```

And the same contrast for functions:

```cpp
constexpr int f(int x) { return x * 2; }   // compile time OR runtime, caller's choice
consteval int g(int x) { return x * 2; }   // compile time ONLY, or compile error

int n = get_input();
f(n); // fine, runs at runtime
g(n); // COMPILE ERROR
g(5); // fine, runs at compile time
```

## 5. Quick-reference cheat sheet

| Situation you're in                                                                                                                  | Use                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| A named constant instead of a magic number/macro                                                                                     | `constexpr` variable                                        |
| A small pure function that _might_ get used for a compile-time value (array size, template arg) but should also work fine at runtime | `constexpr` function                                        |
| A lookup table you want baked into the binary instead of computed at startup                                                         | `constexpr` function returning `std::array`                 |
| A value type's constructor (points, colors, small structs)                                                                           | `constexpr` constructor                                     |
| Validating a template parameter or a compile-time-known input, where a runtime fallback would be a bug, not a convenience            | `consteval` function + `static_assert`                      |
| A type that should never be constructible with a runtime value at all                                                                | `consteval` constructor                                     |
| A mutable global or `thread_local` counter/flag/small POD that needs safe startup order but must change afterward                    | `constinit` variable                                        |
| A mutable global whose initial value needs file I/O, another global, or runtime input                                                | Neither — use a function-local `static` (lazy init) instead |

## 6. C++26 note (brief)

If you keep writing C++ long enough to hit reflection (`std::meta::info`, part of the C++26 working draft as of the June 2025 WG21 vote), you'll notice essentially every reflection function is `consteval` — that's not a coincidence, it's the same "must happen at compile time, no exceptions" guarantee this article covers, just applied to a much bigger API surface. Compiler support is still landing (GCC trunk and Bloomberg's experimental Clang, not yet mainstream MSVC as of this year), so you're unlikely to touch it in a first app — but when you do, everything above still applies.
