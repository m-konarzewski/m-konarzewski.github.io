+++ 
draft = false
date = 2026-09-04T12:12:03+02:00
title = "const char* vs std::string vs std::string_view: When to use each"
tags = ["const-char-ptr", "std-string", "std-string-view"]
categories = ["C++"]
+++

# `const char*` vs `std::string` vs `std::string_view`: When to Use Each

Three ways to represent text in C++, and three completely different relationships to the underlying bytes:

|                                 | `const char*`                  | `std::string`                                    | `std::string_view`                       |
| ------------------------------- | ------------------------------ | ------------------------------------------------ | ---------------------------------------- |
| **Owns the data?**              | No                             | Yes                                              | No                                       |
| **Mutable?**                    | No (through this type)         | Yes                                              | No                                       |
| **Knows its length?**           | No — must scan for `'\0'`      | Yes, `O(1)`                                      | Yes, `O(1)`                              |
| **Guaranteed null-terminated?** | Yes (by convention)            | Yes (since C++11)                                | **No**                                   |
| **Copy cost**                   | Cheap (copies a pointer)       | Expensive (copies bytes, unless SSO — see below) | Cheap (copies a pointer + length)        |
| **Typical use**                 | C API interop, string literals | Owning/building/mutating text                    | Read-only "look at this text" parameters |

That table is the whole article in miniature. Everything below is examples showing _why_ each row matters in practice.

## 1. `const char*` — the one you don't own and don't control the length of

### Where it's still exactly right: string literals

```cpp
const char* greeting = "Hello, world!";
```

String literals have **static storage duration** — this one exists for the entire lifetime of the program, embedded in the binary. `greeting` pointing at it is completely safe, forever. This is the one case where a raw `const char*` is genuinely the simplest, correct tool — no ownership questions, no lifetime questions.

### Where it's still exactly right: C API boundaries

```cpp
FILE* f = fopen("data.txt", "r"); // fopen is a C function — it wants const char*, full stop
if (std::strcmp(argv[1], "--verbose") == 0) { /* ... */ } // classic C-style comparison
```

Any time you're crossing into a C API — `fopen`, `strcmp`, `getenv`, or your own `extern "C"` functions — `const char*` isn't a choice, it's the interface. `std::string` has a `.c_str()` escape hatch for exactly this:

```cpp
std::string path = build_path();
FILE* f = fopen(path.c_str(), "r"); // std::string -> const char* at the C boundary
```

### Where it goes wrong #1: no length means scanning for `'\0'`

```cpp
const char* s = "hello";
size_t len = strlen(s); // O(n) — has to walk the string to find the terminator

// compare that to:
std::string_view sv = "hello";
size_t len2 = sv.size(); // O(1) — length is stored, not computed
```

Every length query on a `const char*` costs you a linear scan. It's easy to forget this is happening when you're calling `strlen()` inside a loop.

### Where it goes wrong #2: dangling pointers from temporaries

This is the bug that catches almost everyone at least once:

```cpp
const char* get_greeting() {
    std::string temp = "Hello, " + get_username();
    return temp.c_str(); // DANGLING — temp is destroyed when the function returns,
}                         // and this pointer now points at freed memory

const char* g = get_greeting();
std::cout << g; // undefined behavior — could print garbage, could crash,
                 // could even "work" by accident, which is the scary part
```

`temp.c_str()` gives you a pointer _into_ `temp`'s internal buffer. The moment `temp`'s destructor runs, that buffer is gone — but the raw pointer doesn't know that, and nothing stops you from using it anyway. This exact shape of bug — a raw view into a `std::string` outliving the `std::string` itself — is the same underlying problem `std::string_view` has (covered in section 3), so keep this example in mind; it comes back.

**Rule of thumb:** if you find yourself storing a `const char*` anywhere other than "this points at a string literal" or "I'm about to pass this straight into a C function and I'm done with it," stop and ask whether you actually need `std::string` or `std::string_view` instead.

## 2. `std::string` — when you need to own and/or mutate text

### Building text incrementally

```cpp
std::string build_message(const std::string& name, int score) {
    std::string result = "Player ";
    result += name;
    result += " scored ";
    result += std::to_string(score);
    result += " points!";
    return result; // ownership transfers out cleanly — no dangling-pointer risk here,
}                   // unlike the const char* version above
```

This is the direct fix for the dangling-pointer example in section 1: because `std::string` owns its buffer, returning one by value is completely safe (and, since C++17's mandatory copy elision / move semantics, cheap — no wasteful copy happens here).

### Storing text as a class member

```cpp
class Player {
public:
    Player(std::string name) : name_(std::move(name)) {} // take by value, move in —
                                                            // the standard idiom for
                                                            // "this class will own a copy"
    const std::string& name() const { return name_; }
private:
    std::string name_;
};
```

Taking `std::string` **by value** and then `std::move`-ing it into the member is the idiomatic pattern here: if the caller passes a temporary, the move is free; if they pass an lvalue they still own, exactly one copy happens (at the call site, which the caller controls) — either way it's at least as efficient as any alternative, and it's simpler to write than overloading for `const std::string&` and `std::string&&` separately.

### Small String Optimization (SSO) — the performance detail most juniors haven't heard of

```cpp
std::string short_str = "hi";        // ~15 characters or fewer, on most implementations
std::string long_str = "this is a much longer string that exceeds the SSO buffer";

std::cout << short_str.capacity();   // typically 15 on libstdc++/libc++ — no heap allocation
std::cout << long_str.capacity();    // heap-allocated — capacity reflects an actual malloc
```

Most standard library implementations store short strings **inline**, directly inside the `std::string` object itself, with no heap allocation at all — typically for strings up to 15 characters on 64-bit libstdc++/libc++ (the exact threshold is implementation-defined, not standardized). This is why `std::string` is often faster than people expect for short text: you only pay for a heap allocation once you cross that threshold.

```cpp
std::string s;
s.reserve(1000); // one allocation upfront, avoiding repeated reallocation as it grows

for (int i = 0; i < 1000; ++i) {
    s += 'x'; // without reserve(), this can trigger O(log n) reallocations as the
}             // string repeatedly outgrows its capacity and has to reallocate + copy
```

If you know roughly how big a string will get before you build it in a loop, `reserve()` upfront avoids the repeated reallocate-and-copy cycle that `+=` in a loop would otherwise trigger.

### `std::string::substr` makes a copy — and that costs you

```cpp
std::string full = "The quick brown fox jumps over the lazy dog";
std::string word = full.substr(4, 5); // "quick" — this ALLOCATES a brand new string
                                        // and copies 5 characters into it
```

Every call to `std::string::substr` allocates and copies. If you're just inspecting a substring — not keeping it around, not mutating it — this is wasted work. That's the exact gap `std::string_view` fills, in the next section.

## 3. `std::string_view` — when you only need to _look_, not own

### The headline use case: function parameters

```cpp
// Before: three overloads, or one that forces a copy for every call site
void print_a(const char* s);          // doesn't accept std::string directly (needs .c_str())
void print_b(const std::string& s);   // doesn't accept a substring without an allocation
void print_c(std::string s);          // copies on every call, even from a literal

// After: one signature, accepts all of the above with zero copies
void print(std::string_view s) {
    std::cout << s << '\n';
}

print("a literal");              // no copy — string_view just points at the literal
std::string owned = "owned text";
print(owned);                    // no copy — string_view points into owned's buffer
print(std::string_view(owned).substr(0, 5)); // owned -> string_view first (still no copy —
                                              // string_view's constructor just takes owned's
                                              // pointer and length), THEN substr on the view,
                                              // which is also just pointer + length arithmetic.
                                              // Compare: owned.substr(0, 5) would call
                                              // std::string::substr and allocate a new string —
                                              // easy mistake, since it reads almost identically.
```

This is the single most common reason to reach for `std::string_view`: a read-only parameter that should accept a string literal, a `std::string`, or a substring, without forcing an allocation just to satisfy the function signature.

### Substrings without allocation

```cpp
std::string_view full = "The quick brown fox jumps over the lazy dog";
std::string_view word = full.substr(4, 5); // "quick" — O(1), no allocation at all,
                                             // just a new (pointer, length) pair
                                             // pointing into the same underlying bytes
```

Compare directly to the `std::string::substr` example above — same operation, but `string_view::substr` just recomputes the pointer and length; nothing is copied or allocated. This is exactly the kind of win you want in a parsing loop.

### A realistic parsing example

```cpp
std::vector<std::string_view> split(std::string_view text, char delim) {
    std::vector<std::string_view> result;
    size_t start = 0;
    while (start < text.size()) {
        size_t end = text.find(delim, start);
        if (end == std::string_view::npos) end = text.size();
        result.push_back(text.substr(start, end - start)); // zero allocations, ever
        start = end + 1;
    }
    return result;
}

for (std::string_view token : split("one,two,three", ',')) {
    std::cout << token << '\n'; // "one", "two", "three" — no heap allocation
}                                // happened anywhere in this whole function
```

This is the pattern that makes `string_view` genuinely valuable rather than just a micro-optimization: a tokenizer/parser that touches every substring of a large input without allocating once, as long as the caller's original text stays alive for as long as the views do — which is exactly the catch covered next.

### The big danger: dangling views (the same bug as section 1, different type)

```cpp
std::string_view get_greeting() {
    std::string temp = "Hello, " + get_username();
    return temp; // DANGLING — identical bug to the const char* version in section 1,
}                 // just via implicit conversion to string_view instead of .c_str()

std::string_view g = get_greeting();
std::cout << g; // undefined behavior, same as before
```

`std::string_view` doesn't fix the dangling-pointer problem from section 1 — it's still just a pointer-and-length pair under the hood. It fixes the _ergonomics_ (no manual length tracking, works with any contiguous character range, not just `std::string`) but the lifetime discipline is entirely on you, the same as with `const char*`.

```cpp
class Config {
public:
    Config(std::string_view name) : name_(name) {} // DANGEROUS if the caller passes
    std::string_view name_;                          // a temporary std::string —
};                                                    // name_ can outlive it

Config c("some literal");        // fine — literal has static storage duration
Config c2(build_name_string());  // DANGEROUS if build_name_string() returns
                                  // a temporary std::string that's destroyed
                                  // at the end of this statement
```

**Rule of thumb:** `std::string_view` is for parameters and short-lived local variables where you can see, by inspection, that the underlying data outlives the view. The moment a `string_view` needs to be _stored_ — as a class member, in a container that outlives the current scope — ask hard whether you actually need `std::string` ownership instead. If you're not sure, `std::string` is the safer default; `string_view` is an optimization you reach for once you've confirmed the lifetime is safe.

## 4. Head-to-head: the same function, three ways

### A `starts_with` check

```cpp
// const char* version — you're on your own for length handling
bool starts_with_c(const char* s, const char* prefix) {
    return std::strncmp(s, prefix, std::strlen(prefix)) == 0;
}

// std::string version — works, but forces the caller to have (or construct) a std::string
bool starts_with_str(const std::string& s, const std::string& prefix) {
    return s.compare(0, prefix.size(), prefix) == 0;
}

// std::string_view version — accepts literals, strings, and substrings, zero copies
bool starts_with_view(std::string_view s, std::string_view prefix) {
    return s.substr(0, prefix.size()) == prefix;
}

starts_with_view("hello world", "hello"); // works directly with two literals —
                                            // the std::string version would have to
                                            // construct two temporary std::strings first
```

(Since C++20, `std::string` and `std::string_view` both actually have a built-in `.starts_with()` member — this example exists to show _how_ you'd hand-roll it and why the parameter type matters, not because you should write this by hand today.)

### Function parameter comparison table

| Parameter type       | Accepts a literal                                                                                         | Accepts a `std::string` | Accepts a substring                   | Copy on call?                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `const char*`        | Yes                                                                                                       | Only via `.c_str()`     | Awkward — needs a temporary           | No (just a pointer)                                        |
| `const std::string&` | Yes (implicit temporary `std::string` construction — a hidden allocation for anything beyond SSO length!) | Yes, no copy            | Only via `.substr()`, which allocates | No, _except_ the hidden literal-to-string conversion above |
| `std::string_view`   | Yes, no copy                                                                                              | Yes, no copy            | Yes, no copy (via `.substr()`)        | Never                                                      |

That middle row is worth sitting with: passing a string literal to a function taking `const std::string&` silently constructs a temporary `std::string` — which means a heap allocation if the literal exceeds the SSO threshold — purely to satisfy the parameter type. This is a genuinely common, easy-to-miss cost in code that "looks" like it's avoiding copies because of the `&`.

## 5. Decision cheat sheet

| Situation you're in                                                                             | Use                                                                                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A string literal that lives for the whole program (config keys, error messages, format strings) | `const char*` (or `std::string_view`, see below)                                                                |
| Calling into a C API (`fopen`, `strcmp`, `extern "C"` functions)                                | `const char*`, via `.c_str()` if you have a `std::string`                                                       |
| A function parameter that only reads the string, never stores it                                | `std::string_view`                                                                                              |
| A function that needs to own, build, or mutate text                                             | `std::string`                                                                                                   |
| Storing text as a class member you'll keep around                                               | `std::string` (safe default) — `std::string_view` only if you've verified the source always outlives the object |
| Parsing/tokenizing a large input without allocating per-token                                   | `std::string_view`, as long as the original text outlives all the tokens                                        |
| Returning a newly built string from a function                                                  | `std::string` (safe, and cheap since C++17's guaranteed copy elision / move semantics)                          |
| A substring you'll just inspect, not keep                                                       | `std::string_view::substr()` — `O(1)`, no allocation                                                            |
| A substring you need to own independently of the original                                       | `std::string::substr()` — allocates, but that's the point                                                       |

## 6. One-line summary

**`const char*`** is for string literals and C interop — no ownership, no length tracking, use it when the type system genuinely doesn't need to know more. **`std::string`** is for when you need to own, build, mutate, or store text safely. **`std::string_view`** is for read-only access without copying — almost always the right choice for function parameters, and a genuine performance win for parsing — but it carries the exact same dangling-pointer risk as `const char*` if you let it outlive the data it points at.
