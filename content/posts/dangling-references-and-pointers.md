+++
draft = false
date = 2026-07-21T15:00:00+02:00
title = "Dangling references and pointers: Mistakes that keep showing up"
tags = ["pointers", "references", "memory-safety", "C++23", "dangling"]
categories = ["C++"]
+++

# Dangling References and Pointers in C++: 10 Mistakes That Keep Showing Up

Dangling references and pointers are one of C++'s most persistent hazards. The compiler often stays silent, the code compiles cleanly, and the bug only shows up as intermittent crashes, corrupted data, or "works on my machine" behavior in production. This article walks through ten of the most common ways developers end up with dangling references or pointers, why they happen, and how to avoid them.

## What "dangling" actually means

A pointer or reference is **dangling** when it refers to memory that has been freed, gone out of scope, or otherwise no longer holds a valid object of the expected type. Using it is undefined behavior (UB) — it might crash immediately, silently return garbage, or appear to work until the memory is reused for something else.

---

## 1. Returning a reference or pointer to a local variable

The classic. The local variable lives on the stack frame of the function; once the function returns, that frame is gone.

```cpp
int& make_value() {
    int local = 42;
    return local; // dangling reference on return
}
```

The compiler will usually warn about this (`-Wreturn-local-addr` in GCC/Clang), but only for the simple, directly-visible cases. Once the local variable is wrapped in a struct, passed through another function, or captured indirectly, the warning often disappears while the bug remains.

**Fix:** return by value, or use dynamic allocation with clear ownership (`std::unique_ptr`, `std::shared_ptr`) if the object truly needs to outlive the function.

---

## 2. Binding a reference to a temporary that outlives its scope

`const T&` extends the lifetime of a temporary — but only for the lifetime of that _specific reference_, and only in narrow, well-defined cases. It's easy to accidentally step outside those cases.

```cpp
struct Widget {
    const std::string& name() const { return name_; }
    std::string name_ = "widget";
};

const std::string& n = Widget{}.name(); // Widget temporary destroyed at end of statement
std::cout << n; // n is dangling
```

The temporary `Widget{}` is destroyed at the end of the full expression, but `n` is a reference into its member — that member's storage no longer exists.

**Fix:** don't hold onto references obtained from a temporary's methods. Store the object by value first, or have the accessor return by value.

---

## 3. Using a pointer after `delete`

The straightforward use-after-free:

```cpp
int* p = new int(10);
delete p;
*p = 20; // dangling pointer, UB
```

Less obvious variants involve `delete` happening inside a function the caller doesn't expect to take ownership, or double-deleting a pointer that's stored in two places.

**Fix:** set pointers to `nullptr` after `delete` as a defensive habit (doesn't fix the root cause but limits damage), and prefer smart pointers so lifetime is managed automatically.

```cpp
auto p = std::make_unique<int>(10);
// no manual delete, no dangling pointer possible from this path
```

---

## 4. Dangling reference after `std::vector` reallocation

This one bites even experienced developers. Taking a reference or pointer to an element, then triggering a reallocation:

```cpp
std::vector<int> v = {1, 2, 3};
int& ref = v[0];
v.push_back(4); // may reallocate, invalidating ref
ref = 10;        // dangling reference, UB
```

`push_back` can trigger a reallocation if capacity is exceeded, and all pointers, references, and iterators into the old buffer become invalid — even ones pointing to elements that didn't move logically.

**Fix:** re-fetch the reference after any operation that might reallocate, use indices instead of references/pointers when the container may grow, or `reserve()` capacity upfront if the size is known.

---

## 5. Iterator invalidation (a dangling iterator is still dangling)

Closely related to #4, but broader — iterators can be invalidated by insertion, erasure, or reallocation depending on the container:

```cpp
std::vector<int> v = {1, 2, 3, 4, 5};
for (auto it = v.begin(); it != v.end(); ++it) {
    if (*it % 2 == 0) {
        v.erase(it); // invalidates it and everything after
    }
}
```

After `erase`, `it` is dangling, and `++it` in the loop is UB.

**Fix:** use the iterator returned by `erase()` itself:

```cpp
for (auto it = v.begin(); it != v.end(); ) {
    it = (*it % 2 == 0) ? v.erase(it) : std::next(it);
}
```

Or use `std::erase_if` (C++20) which handles this correctly for you.

---

## 6. Storing a pointer/reference to a container element, then the container is destroyed or resized

A variant that often shows up in caching or "index" data structures:

```cpp
struct Cache {
    std::vector<std::string> items;
    std::string* last = nullptr;

    void add(std::string s) {
        items.push_back(std::move(s));
        last = &items.back(); // fine right now...
    }
};
```

Every subsequent call to `add()` risks invalidating `last` due to reallocation. The bug is latent — it might work for months until the vector happens to grow past its capacity at the wrong moment.

**Fix:** store an index instead of a pointer, or use a container with stable addresses (`std::deque` for stable references on push_back/push_front, or `std::list` for full stability).

---

## 7. Returning `.c_str()` or a `string_view` from a temporary `std::string`

```cpp
const char* get_name() {
    std::string s = "temporary";
    return s.c_str(); // pointer into s's buffer, dangling after return
}
```

The `std::string_view` version is even sneakier because it looks "modern" and safe:

```cpp
std::string_view sv = std::string("hello") + " world"; // dangling immediately
```

`string_view` never owns data — it's a non-owning view. If the string it views is a temporary, the view dangles before you even get to use it.

**Fix:** return `std::string` by value; only use `string_view` when you can guarantee the referenced string outlives the view.

---

## 8. Lambdas capturing local variables by reference, used after the scope ends

```cpp
std::function<int()> make_adder(int x) {
    int y = 10;
    return [&x, &y]() { return x + y; }; // both captures dangle after return
}
```

This is especially dangerous with `std::function` and callback-based APIs (event handlers, thread pools, async tasks), where the lambda is invoked much later — long after the enclosing scope, and its stack frame, are gone.

**Fix:** capture by value (`[x, y]`) when the lambda will outlive the current scope, or explicitly manage lifetime with `shared_ptr` if the captured object is expensive to copy but needs shared ownership.

---

## 9. Dangling `this` in async callbacks or detached threads

A member function captures `this` (implicitly via `[this]` or a member lambda), and the object is destroyed before the callback fires:

```cpp
class Sensor {
public:
    void start_async_read(Scheduler& sched) {
        sched.on_data([this](int value) {
            process(value); // this may be dangling if Sensor was destroyed
        });
    }
    void process(int) { /* ... */ }
};
```

If `Sensor` is destroyed before `on_data`'s callback runs (common with detached threads, timers, or fire-and-forget async operations), `this` is dangling and `process()` is called on a dead object.

**Fix:** there are a few ways to make this safe, depending on how strict you need to be about the object staying alive:

- **Extend lifetime with `shared_from_this()`.** If `Sensor` inherits from `std::enable_shared_from_this<Sensor>` and is always managed via `shared_ptr`, capture `auto self = shared_from_this()` in the lambda. This keeps the object alive for as long as the callback might fire — simple, but means the object won't be destroyed early even if the caller wants it to be.
- **Capture `weak_from_this()` (or a `weak_ptr` member) and `lock()` before use.** This doesn't keep the object alive artificially — if it's already been destroyed, `lock()` returns an empty `shared_ptr` and you can skip the callback safely instead of touching a dangling `this`.
- **Tie the async operation's lifetime to the object's lifetime explicitly**, e.g. cancel or invalidate pending callbacks in the destructor, so they never fire after the object is gone.

```cpp
class Sensor : public std::enable_shared_from_this<Sensor> {
public:
    void start_async_read(Scheduler& sched) {
        sched.on_data([weak = weak_from_this()](int value) {
            if (auto self = weak.lock()) {
                self->process(value); // safe: self is alive here, or we skip
            }
        });
    }
    void process(int) { /* ... */ }
};
```

Use `shared_from_this()` when you want the callback to guarantee execution; use `weak_from_this()` + `lock()` when it's fine (or preferable) for the callback to be silently skipped once the object is gone.

---

## 10. Range-based `for` over a temporary container

```cpp
for (int x : get_values()) { // fine if get_values() returns by value
    std::cout << x;
}

// but:
for (char c : std::string("hello") + "!") { // temporary destroyed, dangling
    std::cout << c;
}
```

The specific danger is when the loop's range-expression produces a temporary that owns data, but what you actually iterate over is a _view_ into that temporary — e.g. the `std::string` concatenation above works fine on its own, but combining it with `string_view`-returning functions or references to members reintroduces the problem from #2 inside a loop.

A more subtle real case:

```cpp
struct Container {
    const std::vector<int>& get_data() const { return data_; }
    std::vector<int> data_;
};

for (int x : Container{}.get_data()) { // Container temporary destroyed,
    // data_ member (and the vector's storage) is gone
}
```

**A note on C++ versions:** this example's status depends on your language standard. Under C++11 through C++20, the range-based `for` loop only extends the lifetime of a temporary that is _directly_ bound to the hidden range reference. Here, what's directly returned is a `const std::vector<int>&` into the `Container{}` temporary — not the temporary itself — so extension doesn't propagate through the function call. `Container{}` is destroyed before the loop body even runs, and every dereference in the loop is UB.

**C++23 changes this.** Under the rules from [P2644R1](https://wg21.link/P2644R1), temporaries created while evaluating the range-expression now have their lifetime extended to the end of the loop, so this specific example becomes well-defined when compiled with `-std=c++23`. It's still worth flagging in code review, though — plenty of codebases aren't on C++23 yet, and the pattern is confusing enough that being explicit is better than relying on the standard version.

**Fix:** be explicit about ownership — bind the temporary to a named variable first if you need it to survive the whole loop:

```cpp
Container c;
for (int x : c.get_data()) { /* safe, c outlives the loop */ }
```

---

## General defenses against dangling references and pointers

- **Prefer value semantics.** Return by value; let move semantics make it cheap. RVO/NRVO usually eliminates the copy entirely.
- **Prefer smart pointers for owned dynamic memory.** `unique_ptr` for single ownership, `shared_ptr`/`weak_ptr` when lifetime genuinely needs to be shared or tracked.
- **Use indices instead of pointers/references/iterators into containers that can grow or shrink**, unless you know the container type gives you stability guarantees.
- **Treat `string_view`/`span` as strictly non-owning.** Never let one outlive the object it views; be especially careful with temporaries.
- **Turn on compiler warnings and static analysis.** `-Wall -Wextra -Wdangling-else` and Clang's lifetime analysis catch a meaningful subset of these bugs. `-fsanitize=address,undefined` catches most of the rest at runtime.
- **Be deliberate about capture semantics in lambdas.** Default to `[=]`/by-value captures unless you have a concrete reason and a lifetime guarantee for `[&]`.

Dangling pointers and references are rarely caused by ignorance of the rules — they're caused by valid code changing shape over time: a container that used to be small enough to never reallocate, a callback that used to run synchronously, a reference that used to be short-lived. Defensive design (value semantics, smart pointers, index-based access) turns what would be a silent UB bug into a compile error or a clear runtime failure, which is exactly the trade you want.
