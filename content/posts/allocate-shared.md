+++ 
draft = false
date = 2026-09-28T17:03:14+02:00
title = "std::allocate_shared"
tags = ["C++", "std::allocate_shared", "custom-allocator", "std::shared_ptr"]
categories = ["C++"]
+++

If you've internalized why `std::make_shared` beats `std::shared_ptr<T>(new T(...))` — a single combined allocation instead of two, better cache locality, one less trip to the allocator — the natural next question is: what if I don't want that allocation to come from the global `operator new`? That's exactly the gap `std::allocate_shared` fills, and its C++20 sibling `std::allocate_shared_for_overwrite` extends the idea to array and trivial-type construction. This post covers what they do, the problems they solve, when to reach for them, and a full working example built on a custom arena allocator.

## 1. What it's for

To understand `allocate_shared`, start with what a `shared_ptr` actually owns. Every `shared_ptr` is backed by two logically distinct pieces of state:

- a **control block** — the strong reference count, the weak reference count, a type-erased deleter, and (if constructed via an allocator) a type-erased allocator;
- the **managed object** itself, the `T`.

The naive construction `std::shared_ptr<T>(new T(args...))` performs **two separate heap allocations**: one for `T` via `new`, and a second, internal one for the control block when the `shared_ptr` is constructed. Two allocator calls, and the object and its control block can end up in entirely different cache lines — or different pages.

`std::make_shared<T>(args...)` exists specifically to collapse that into **one allocation**: the control block and the object are laid out contiguously in a single block. The catch is that `make_shared` always goes through `std::allocator<T>` — effectively the global `operator new`. You have zero say in where that memory comes from.

`std::allocate_shared<T>(alloc, args...)` is the missing piece: it gives you the **same single-allocation layout as `make_shared`**, but routed through **an allocator you supply**. That's the entire point of the function — the performance characteristics of `make_shared`, with the flexibility of a custom allocator.

## 2. What problems it solves

**Problem A — `make_shared` is not configurable.** If you need the object behind a `shared_ptr` to live in an arena, a fixed-size pool, an `mmap`-backed region, memory shared between processes, or a NUMA-aware allocator, `make_shared` simply can't do it — the allocator is hardcoded. `allocate_shared` can, because you pass the allocator explicitly.

**Problem B — the allocator-aware `shared_ptr` constructor doesn't give you one allocation.** `shared_ptr` does have a constructor of the form `shared_ptr(T*, Deleter, Alloc)`, available since C++11. But if you're passing a `T*` you already created via `new T(...)`, that object was allocated outside the allocator's control, and the control block is allocated separately through `Alloc`. You're back to two allocations — you lose exactly the optimization `make_shared`/`allocate_shared` exist to provide.

**Problem C — knowing when the memory actually comes back.** Because the control block and the object share one allocation, that block cannot be deallocated until **every** `shared_ptr` _and_ every `weak_ptr` referencing it has been destroyed. The last `shared_ptr` going out of scope triggers `T`'s destructor, but the actual `deallocate()` call only happens when the last `weak_ptr` dies too. With a custom allocator — especially a bounded pool — this has real design consequences: a "dead" object kept alive only by a stray `weak_ptr` still occupies a slot.

### What's actually happening under the hood

Worth spelling out for readers who want the internals: `allocate_shared` instantiates an internal type that represents the _combined_ control block + storage-for-`T` (in libstdc++ this is roughly `__shared_ptr_inherit`/`_Sp_counted_ptr_inplace<T, Alloc>`; libc++ has an analogous `__shared_ptr_emplace`). It then uses `std::allocator_traits<Alloc>::rebind_alloc` to convert your `Alloc<T>` into an allocator for that combined type, calls `allocate(1)` on it, and placement-constructs `T` inside the resulting block.

This rebinding step is why your allocator needs to satisfy the full _Allocator_ named requirements from `<memory>` — not just "has `allocate`/`deallocate`." Standard-library allocators handle this transparently through `allocator_traits`, but a hand-rolled allocator needs a converting constructor template (`template<class U> Alloc(const Alloc<U>&)`) so the rebind actually works.

### A common trap: class-specific `operator new`/`operator delete` are silently bypassed

This one catches people who've already optimized their class with a custom `operator new`/`operator delete` — for a fixed alignment requirement, a per-class pool, or allocation tracking — and then wrap it in `make_shared` expecting that logic to still run. It doesn't.

`make_shared<T>(...)` never evaluates an expression equivalent to `new T(...)`. Internally it:

1. allocates a raw block (control block + storage for `T`, combined) via `std::allocator<T>::allocate`, i.e. effectively the **global** `::operator new`;
2. constructs `T` **in place** inside that block via placement-new: `::new (ptr) T(args...)`.

Placement-new doesn't call any allocating operator — the memory already exists, placement-new only runs the constructor at a given address. Since `T` is never created through an ordinary `new T(...)` expression, your class's overloaded `T::operator new` is never invoked. The same holds in reverse at destruction: the object is destroyed with a direct call to its destructor (`ptr->~T()`), and the block is released via the allocator's `deallocate`, not via `T::operator delete`.

`allocate_shared<T>(alloc, ...)` behaves identically — the only difference is that the combined block comes from `alloc` (after rebinding) instead of the global `operator new`. Either way, any class-specific `operator new`/`operator delete` is completely skipped.

**Practical consequence:** if `T` overloads `operator new`/`operator delete` to enforce alignment, route through a pool, or instrument allocations, `make_shared<T>` quietly ignores all of it — the object still goes through `std::allocator<T>` (the global `new`). If you need `shared_ptr` to actually respect your allocation strategy, the only correct route is `allocate_shared<T>(my_allocator, ...)` with an allocator that does what your `operator new` would have done — not relying on `make_shared` to "notice" the class's overloaded operators, because it never looks at them.

## 3. When to use it

- **`std::pmr::polymorphic_allocator`** — the most common real-world case. You want `shared_ptr`-managed objects to live in a specific `memory_resource`, e.g. a `monotonic_buffer_resource` scoped to one frame or one request.
- **Pools/arenas for high-frequency allocation** — buffers created and destroyed constantly, such as per-frame wrapper objects in a video pipeline (relevant if you're working with FFmpeg — decoded-frame wrappers allocated thousands of times per second are exactly where heap fragmentation and `malloc`/`free` overhead show up).
- **NUMA-aware allocation** — pinning objects to a specific memory node on multi-socket systems.
- **Shared/mapped memory** — when a `shared_ptr` needs to live in memory shared across process boundaries (`mmap`, IPC segments).
- **Instrumentation and debugging** — an allocator that counts, tags, or tracks allocations for leak detection.
- **`allocate_shared_for_overwrite` (C++20)** — the allocator-aware counterpart to `make_shared_for_overwrite`. For trivially-constructible types it skips value-initialization entirely — no zeroing. Worth it whenever you're about to overwrite the whole object anyway (a buffer you're about to fill from a decoder, say): you avoid writing the memory twice, once for initialization and once for real data. As of C++20, both `make_shared` and `allocate_shared` also support array types (`T[]`, both known and unknown bound), so this applies to arrays too.

**When not to use it:** without a concrete reason — a specific allocator, a pool, PMR — plain `make_shared` is simpler and equally fast. `allocate_shared` buys you nothing without a meaningful allocator behind it.

## 4. Practical example

Below is a minimal but complete illustration: a small monotonic arena allocator paired with `allocate_shared`, followed by the more idiomatic PMR version, and finally `allocate_shared_for_overwrite`.

```cpp
#include <memory>
#include <memory_resource>
#include <cstddef>
#include <new>
#include <array>
#include <iostream>

// --- Version 1: a minimal, STL-compatible arena allocator ---
template <typename T>
struct ArenaAllocator {
    using value_type = T;

    std::byte* buffer;
    std::size_t capacity;
    std::size_t offset = 0;

    ArenaAllocator(std::byte* buf, std::size_t cap)
        : buffer(buf), capacity(cap) {}

    // required converting constructor — this is what rebind() relies on
    template <typename U>
    ArenaAllocator(const ArenaAllocator<U>& other)
        : buffer(other.buffer), capacity(other.capacity), offset(other.offset) {}

    T* allocate(std::size_t n) {
        std::size_t bytes = n * sizeof(T);
        std::size_t aligned = (offset + alignof(T) - 1) & ~(alignof(T) - 1);
        if (aligned + bytes > capacity) throw std::bad_alloc{};
        T* ptr = reinterpret_cast<T*>(buffer + aligned);
        offset = aligned + bytes;
        return ptr;
    }

    void deallocate(T*, std::size_t) noexcept {
        // arena is freed en masse; a single deallocate() is a deliberate no-op
    }
};

struct Frame {
    int width, height;
    Frame(int w, int h) : width(w), height(h) {
        std::cout << "Frame(" << w << "x" << h << ") constructed\n";
    }
    ~Frame() { std::cout << "Frame destroyed\n"; }
};

void arena_example() {
    alignas(std::max_align_t) std::byte storage[1024];
    ArenaAllocator<Frame> alloc(storage, sizeof(storage));

    // one allocation: control block + Frame, side by side, inside the arena
    std::shared_ptr<Frame> frame = std::allocate_shared<Frame>(alloc, 1920, 1080);

    std::cout << "use_count: " << frame.use_count() << "\n";
} // Frame's destructor runs here; the block is logically reclaimed with the arena

// --- Version 2: std::pmr, the more idiomatic real-world form ---
void pmr_example() {
    std::array<std::byte, 4096> buffer;
    std::pmr::monotonic_buffer_resource resource(buffer.data(), buffer.size());
    std::pmr::polymorphic_allocator<Frame> palloc(&resource);

    auto frame = std::allocate_shared<Frame>(palloc, 1280, 720);
    std::cout << "use_count: " << frame.use_count() << "\n";
}

// --- Version 3: allocate_shared_for_overwrite (C++20) — e.g. a sample buffer ---
int decode_sample(int i); // supplied elsewhere

void for_overwrite_example() {
    std::pmr::monotonic_buffer_resource resource(1 << 20);
    std::pmr::polymorphic_allocator<int[]> palloc(&resource);

    // array form: no value-initialization, since every element gets overwritten anyway
    auto samples = std::allocate_shared_for_overwrite<int[]>(palloc, 4096);
    for (int i = 0; i < 4096; ++i) samples[i] = decode_sample(i);
}
```

### Comparison at a glance

|                                     | `new T` + `shared_ptr`                                                    | `make_shared<T>`            | `allocate_shared<T>(alloc, ...)` |
| ----------------------------------- | ------------------------------------------------------------------------- | --------------------------- | -------------------------------- |
| Allocations                         | 2 (object, then control block)                                            | 1 (combined block)          | 1 (combined block)               |
| Allocator used                      | global `operator new` for `T`; internal allocator for control block       | fixed: `std::allocator<T>`  | any allocator you supply         |
| Memory source configurable          | partially (deleter/allocator constructor exists, but still 2 allocations) | no                          | yes                              |
| Needs full _Allocator_ requirements | no                                                                        | no                          | yes (rebind support)             |
| `weak_ptr` retains the whole block  | n/a (two separate blocks)                                                 | yes                         | yes                              |
| Array support (C++20)               | n/a                                                                       | yes                         | yes                              |
| `for_overwrite` variant             | n/a                                                                       | `make_shared_for_overwrite` | `allocate_shared_for_overwrite`  |

### Cheat sheet

- No specific memory-source requirement → `make_shared`. Simpler, same performance.
- Objects need to live in a pool, arena, PMR resource, shared memory, or NUMA-pinned region → `allocate_shared`.
- About to fully overwrite a scalar/array object right after construction → the `_for_overwrite` variant, to skip value-initialization.
- Writing a custom allocator for use with `allocate_shared` → make sure it satisfies the full _Allocator_ requirements, including a converting constructor for `rebind` — this is not optional, `allocate_shared` depends on it internally.
- Using a bounded pool allocator → account for the fact that a lingering `weak_ptr` keeps the _entire_ combined block alive, not just a small side-table entry.
