+++ 
draft = false
date = 2026-07-31T18:05:19+02:00
title = "noexcept — More than a promise: How it shapes performance and container behavior"
tags = ["C++", "noexcept", "move-semantics", "vector", "move-if-noexcept"]
categories = ["C++"]
+++

If you've written modern C++ for any length of time, you've typed `noexcept` dozens of times — usually on a move constructor, usually without thinking too hard about it. Most engineers treat it as a hint to the compiler: "this is fast, go ahead and optimize." That intuition is only half right, and the half that's wrong can quietly turn your `std::vector<T>` into an O(n) copy machine on every reallocation.

This article looks at what `noexcept` actually guarantees, where the real performance impact comes from, and — the main event — how it drives `std::vector`'s reallocation strategy through `std::move_if_noexcept`.

## 1. What `noexcept` actually is

`noexcept` shows up in two forms that are easy to conflate:

- **The specifier**, attached to a function declaration: `void f() noexcept;`
- **The operator**, which queries at compile time whether an expression is noexcept: `noexcept(expr)` evaluates to a `bool`.

The specifier itself takes an optional constant expression: `noexcept(true)`, `noexcept(false)`, or just bare `noexcept`, which is shorthand for `noexcept(true)`.

The most important thing to internalize: **`noexcept` does not mean "this function cannot throw."** It means "if this function throws, `std::terminate` is called immediately." The compiler does not verify at compile time that the body is exception-free — a `noexcept` function with a `throw` statement inside compiles cleanly. It just blows up at runtime if that path is ever taken.

The genuinely useful pattern in generic code is **conditional noexcept**:

```cpp
template <typename T>
void wrapper(T& t) noexcept(noexcept(t.doSomething())) {
    t.doSomething();
}
```

This propagates the noexcept-ness of the wrapped call outward, which is exactly the mechanism the standard library leans on constantly — you'll see this shape in `std::swap`, in container move operations, in `std::optional`, and elsewhere.

## 2. Performance impact — where it actually matters (and where it doesn't)

A common myth: "`noexcept` lets the compiler skip generating exception-handling machinery, so the function itself runs faster." This is mostly false for the function's own body. Most modern ABIs (notably the Itanium C++ ABI used by GCC/Clang) implement exceptions with a zero-cost model — there's no runtime overhead on the non-throwing path regardless of whether the function is `noexcept`. Marking a function `noexcept` typically does _not_ make its instructions run faster.

Where the real wins come from:

- **Caller-side optimization decisions.** This is the big one. Library code — especially STL containers and algorithms — checks `std::is_nothrow_move_constructible`, `std::is_nothrow_swappable`, etc., via type traits and branches its _strategy_ based on the answer. This is a decision made once, at compile time, that can change an algorithm's complexity class. Section 3 covers the flagship example.
- **Code size, marginally.** A `noexcept` function doesn't need unwind tables/landing pads for stack unwinding through it in some cases, which can shrink generated code slightly. This is a minor, ABI-dependent effect, not something to optimize for on its own.
- **Enabling further compiler reasoning.** Because a `noexcept` function is guaranteed to either return normally or call `std::terminate`, the compiler has one fewer control-flow path to account for, which can occasionally aid inlining and other transformations. Don't expect measurable gains from this alone in typical code.

So: `noexcept` is best understood as **metadata that changes decisions made by other code**, not a magic speed switch on the function itself.

## 3. The core case: `std::vector` reallocation and `move_if_noexcept`

This is where `noexcept` stops being a style preference and starts being a correctness-adjacent performance decision.

### The guarantee `std::vector` has to uphold

`std::vector::push_back` (and `reserve`, `resize`, `insert`, etc.) offers the **strong exception guarantee**: if an exception is thrown during the operation, the vector is left exactly as it was before the call — no partial state, no corruption.

Reallocation is the tricky case. When `push_back` triggers a growth, the vector must:

1. Allocate new, larger storage.
2. Transfer all existing elements from the old storage to the new storage.
3. Deallocate the old storage.

Step 2 is the problem. If transferring elements uses the **move constructor**, and that move constructor throws partway through, the vector is now in a mess: some elements have been moved-from in the old buffer, some constructed in the new buffer, and the operation cannot be rolled back cleanly. That would violate the strong exception guarantee.

If transferring instead uses the **copy constructor**, a throw partway through is safe — the original elements in the old buffer are untouched (copies don't mutate the source), so the vector can simply discard the partially-built new buffer and the caller sees the original vector, intact.

### The resolution: `std::move_if_noexcept`

The standard library's answer is `std::move_if_noexcept<T>`, which the internals of `std::vector` (and other containers) use during these transfer operations instead of a bare `std::move`. Its logic:

```cpp
template <typename T>
constexpr std::conditional_t<
    !std::is_nothrow_move_constructible_v<T> && std::is_copy_constructible_v<T>,
    const T&,
    T&&>
move_if_noexcept(T& x) noexcept;
```

In plain terms:

- If `T`'s move constructor is `noexcept` → move it. Safe, fast, strong guarantee preserved.
- If `T`'s move constructor **can throw**, _and_ `T` is copyable → treat it as an lvalue, forcing a **copy** instead. Slower, but safe.
- If `T`'s move constructor can throw and `T` is **not** copyable (move-only type, e.g. holding a `unique_ptr`) → move anyway, because there's no fallback available. The guarantee is quietly relaxed in this one case, since the alternative is not compiling at all.

The practical consequence: **a type with a throwing move constructor gets silently, invisibly downgraded to copy semantics during every `vector` reallocation.** No warning, no error — just a slower program, discoverable only through profiling or by knowing to check `is_nothrow_move_constructible`.

### Making this concrete: `vector<A>` vs `vector<B>`

A common mistake when reasoning about this: reaching for a member like `std::vector<int>` or `std::string` and assuming the wrapping type's move constructor might "throw" for some hand-wavy reason. It won't — moving a `std::vector` or `std::string` is itself `noexcept` and O(1) (pointer steal), so a constructor that only moves such members can never realistically throw, regardless of whether you remembered to write the `noexcept` keyword. That makes for a dishonest benchmark.

A cleaner setup: two otherwise-identical classes, `A` and `B`, each owning a heap buffer cheaply transferable by stealing a pointer. The _only_ difference between them is the `noexcept` keyword on the move constructor. Put instances of each into their own `std::vector` and watch what happens on reallocation.

```cpp
struct A { // move constructor WITHOUT noexcept
    std::unique_ptr<int[]> data;
    size_t size;

    explicit A(size_t n) : data(std::make_unique<int[]>(n)), size(n) {}

    A(A&& other) : data(std::move(other.data)), size(other.size) {
        other.size = 0;
    }

    A(const A& other) : data(std::make_unique<int[]>(other.size)), size(other.size) {
        std::copy(other.data.get(), other.data.get() + size, data.get());
    }
};

struct B { // move constructor WITH noexcept
    std::unique_ptr<int[]> data;
    size_t size;

    explicit B(size_t n) : data(std::make_unique<int[]>(n)), size(n) {}

    B(B&& other) noexcept : data(std::move(other.data)), size(other.size) {
        other.size = 0;
    }

    B(const B& other) : data(std::make_unique<int[]>(other.size)), size(other.size) {
        std::copy(other.data.get(), other.data.get() + size, data.get());
    }
};

static_assert(!std::is_nothrow_move_constructible_v<A>);
static_assert(std::is_nothrow_move_constructible_v<B>);
```

Both move constructors do exactly the same real work — steal a pointer, zero out the source's size. Neither can actually throw. The only difference between `A` and `B` is one keyword, yet `is_nothrow_move_constructible` reports different answers, and that's all `std::vector` needs to make a completely different decision.

**Proof by counting, not just timing.** Instrumenting both constructors with static call counters and pushing 20,000 elements (no `reserve()`, forcing normal geometric-growth reallocation) into `std::vector<A>` and `std::vector<B>` separately gives an unambiguous answer:

```
A: copyCount = 32767, moveCount = 0
B: copyCount = 0,     moveCount = 32767
```

Every single reallocation of `vector<A>` went through the copy constructor — full reallocation, full `make_unique<int[]>` call, full element-by-element copy — despite the move constructor being right there, perfectly capable, never throwing in practice. `vector<B>` never copied a single element; every transfer during growth was a pointer steal.

**And the timing bears it out.** Same benchmark (`payload = 1000` ints per object, median of 7 runs):

```
vector<A> (throwing move -> falls back to copy): 46.7 ms
vector<B> (noexcept move):                       23.6 ms
Ratio A/B: ~1.98x
```

Note that even this understates the effect for larger payloads: the gap between "steal a pointer" and "allocate + `memcpy` N ints" grows with the size of the owned buffer. At `payload = 1000` you're already looking at more than double the runtime for the reallocation-heavy portion of the program — purely because of one missing keyword, with the underlying operation completely unchanged.

A good habit to show readers: assert your intent so a regression doesn't silently creep back in.

```cpp
static_assert(std::is_nothrow_move_constructible_v<NoexceptMove>,
              "NoexceptMove must have a noexcept move constructor for vector performance");
```

This is a cheap, zero-runtime-cost guard worth putting near any type you specifically designed to be cheap to move.

## 4. Practical rule for user-defined types

**Mark move constructors and move assignment operators `noexcept` whenever they genuinely cannot throw** — which, for most types, means whenever the move operation is just transferring ownership of resources (pointers, handles, other movable members) without allocating, without doing I/O, without calling code that isn't itself noexcept.

What tends to break the guarantee, worth calling out explicitly:

- A member whose move constructor allocates — some custom small-buffer-optimized types have a fallback heap path that can throw on move.
- Any user-added logic inside the move constructor: logging, validation, format conversion, anything beyond "steal state, null out source."
- A base class or member with a **non-noexcept** move operation — noexcept-ness doesn't propagate automatically, so one non-noexcept member anywhere in the chain infects the whole type unless you explicitly guard it.

Worth an explicit worked example: **implicitly generated move operations.** If you don't declare move ctor/assignment yourself, the compiler-generated ones are `noexcept` _if and only if_ every base and member's corresponding operation is `noexcept`. This is transitive and easy to break by adding one `std::string`-like member with a throwing move — or one member that has no move constructor at all and falls back to a throwing copy. This is a good place in the article to show a small chain of 3 types, break the noexcept-ness on the innermost one, and show it propagating outward silently.

`std::string` itself is worth a footnote: its move constructor is `noexcept` per the standard, so it's not usually the culprit — but user types that hold raw owning resources with fallible cleanup logic often are.

## 5. Other STL touchpoints worth mentioning

- **`std::swap` and `noexcept(swap(...))`** — the standard `swap` for user types is conventionally written with a conditional noexcept that mirrors the noexcept-ness of the underlying move operations. `std::sort`, `std::vector::swap`, and various algorithms query this to decide their own exception-safety strategy, similar in spirit to the `move_if_noexcept` story.
- **Destructors** — implicitly `noexcept(true)` unless you explicitly say otherwise. A throwing destructor is almost always a design bug: if it fires during stack unwinding from another exception, you get `std::terminate` immediately (two active exceptions can't coexist). Worth a short cautionary paragraph with an example of a destructor that closes a resource and "helpfully" throws on failure.
- **`std::function`, `std::optional`, `std::variant`** — their move operations conditionally propagate the noexcept-ness of the type(s) they hold. `std::variant`'s case is particularly interesting (and a little painful) because of the valueless-by-exception state it can enter if a throwing move happens during certain operations — possibly worth a dedicated callout box rather than full treatment here.
- **Allocator-aware containers** — allocator propagation traits (`propagate_on_container_move_assignment`, etc.) interact with noexcept-ness in ways that decide whether a container move assignment can itself be noexcept. This is deep enough to be its own short article rather than a subsection.

## 6. Common pitfalls

- **Lying to the compiler.** Marking a function `noexcept` when it can, in fact, throw (e.g., an allocation hides inside a "trivial-looking" move) doesn't produce a compile error — it produces a silent `std::terminate` at runtime, with a call stack that often looks nothing like the actual bug. This is one of the nastier categories of "worked in testing, crashed in production" bugs.
- **Forgetting `noexcept` on a move constructor for a type destined to live in `std::vector`.** No compiler warning, no error — just an O(n) copy cascade on every growth that only shows up as "this is mysteriously slow" in a profiler.
- **Pre-C++17 vs. post-C++17 semantics.** Before C++17, the exception specification wasn't part of the function's type, so `void(*)() noexcept` and `void(*)()` were compatible/interchangeable in more contexts. C++17 made the exception specification part of the function type, which affects function pointer assignment, template argument deduction, and overload resolution in subtle ways — worth a short before/after code sample.

## 7. TL;DR — Should I mark this `noexcept`?

A short decision checklist to close the article:

- Does the function only transfer ownership / pointers / trivial state? → **Yes, mark it `noexcept`.**
- Does it allocate, do I/O, call unknown/virtual code, or call anything not itself `noexcept`? → **Don't mark it `noexcept`** unless you've audited every path.
- Is it a destructor? → **Leave it `noexcept` (the default).** Never make it throw.
- Is it a move constructor for a type that will live in `std::vector` (or similar)? → **This is the highest-value place to get it right.** Check with `static_assert(std::is_nothrow_move_constructible_v<T>)`.
- Writing generic/template code? → **Use conditional `noexcept(noexcept(...))`** rather than hardcoding true/false.
