+++ 
draft = false
date = 2026-09-29T11:26:18+02:00
title = "std::out_ptr and std::inout_ptr: Adapting C's T** APIs"
tags = ["std::out_ptr", "std::inout_ptr"]
categories = ["C++"]
+++

# C++23 `out_ptr` and `inout_ptr`: Adapting C's `T**` APIs

C APIs routinely hand back resources through a pointer-to-pointer output parameter:

```c
int foreign_setter(T** out);
```

Wrapping this kind of call in a `std::unique_ptr` or `std::shared_ptr` has always meant a raw pointer, a manual call, and a manual `reset()` — three separate steps with a window in between where nothing owns the resource yet. C++23 adds four names to `<memory>` to close that window: `std::out_ptr`, `std::inout_ptr`, and the adapter types they return, `std::out_ptr_t` and `std::inout_ptr_t` (from [P1132](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2021/p1132r8.html)). This article works through what each one does under the hood, then applies `out_ptr` to FFmpeg's demuxer and allocation functions, and closes with an invented C API to show where `inout_ptr` is the right tool.

## 1. `out_ptr` and `out_ptr_t`

### The problem

```c
int foreign_setter(T** out); // allocates *out on success
```

Before C++23:

```cpp
T* raw = nullptr;
int ec = foreign_setter(&raw);
std::unique_ptr<T, D> up;
if (ec == 0) up.reset(raw);
```

### The adapter

```cpp
template <class Pointer = void, class Smart, class... Args>
/* out_ptr_t<...> */ out_ptr(Smart& s, Args&&... args) noexcept;
```

`out_ptr(s, args...)` constructs a temporary of type `out_ptr_t<Smart, Pointer, Args...>`. That temporary is implicitly convertible to `Pointer*` (deduced, in order, from an explicit `Pointer` template argument, `Smart::pointer`, or `Smart::element_type*`), so it can be passed anywhere a C function expects a `T**`. The temporary itself doesn't own anything while the call is in flight — it just exposes a `Pointer*` slot for the C function to write into. What makes it useful is the destructor: when the temporary goes out of scope, at the end of the full expression containing the call, it invokes `s.reset(p, args...)` with whatever the C function wrote into that slot, forwarding along any extra arguments that were passed to `out_ptr` itself (useful for a `unique_ptr` whose `reset` also wants a deleter or allocator argument).

cppreference states the equivalence directly. This:

```cpp
int foreign_setter(T**);
std::unique_ptr<T, D> up;

if (int ec = foreign_setter(std::out_ptr(up)))
    return ec;
```

is roughly equivalent to:

```cpp
int foreign_setter(T**);
std::unique_ptr<T, D> up;
T* raw_p{};

int ec = foreign_setter(&raw_p);
up.reset(raw_p);
if (ec != 0)
    return ec;
```

Two details worth internalizing from that expansion:

- `raw_p` starts **value-initialized** (null for a plain pointer), not seeded from `up`'s current value. `out_ptr` never looks at what `up` held before the call — the C function sees an empty slot every time, regardless of whether `up` was already managing something.
- `up.reset(raw_p)` runs unconditionally, even when `ec != 0`. If `foreign_setter` leaves `*out` untouched or null on failure, `reset(nullptr)` is a harmless no-op; if `up` already owned something from before the call, `reset` deletes the old value first exactly as it always does. Nothing here depends on how the C function failed.

### The `shared_ptr` guardrail

`out_ptr_t`'s destructor is unconditionally `noexcept`, so with `shared_ptr` the one operation that can genuinely throw — allocating a new control block — has to happen in the constructor, not the destructor, or an exception mid-unwind would be unrecoverable. Because of that, `shared_ptr::reset(p)` needs an explicit deleter argument when there isn't a default one for `p`'s type (just as a direct call to `reset` would), and the standard enforces this for `out_ptr` with a `static_assert`:

```cpp
std::shared_ptr<int> r;
int err = foreign_setter(std::out_ptr(r)); // ill-formed: no deleter given
```

```
error: static assertion failed: a deleter must be used when
       adapting std::shared_ptr with std::out_ptr
```

Passing a deleter as the extra `args...` — `std::out_ptr(r, MyDeleter{})` — satisfies it.

## 2. `inout_ptr` and `inout_ptr_t`

### The problem

Some C functions don't just write a new value through a `T**` output parameter — they also need to **read** whatever is already there, because the existing pointer is itself an input: a resource to reuse, reconfigure, or replace.

```c
int foreign_resetter(T** inout); // reads *inout, may replace it
```

`out_ptr` can't be used here, because its temporary always starts empty — the C function would never see the resource `up` already owns.

### The adapter

```cpp
template <class Pointer = void, class Smart, class... Args>
/* inout_ptr_t<...> */ inout_ptr(Smart& s, Args&&... args) noexcept;
```

`inout_ptr` has the same surface shape as `out_ptr`, with one structural difference: its **constructor** calls `s.release()` up front and seeds the temporary with the pointer that call returns — so the C function genuinely receives `up`'s current value through the `T**` slot, not an empty one. `release()` relinquishes `up`'s ownership without deleting anything, which matters here: if the C function is about to free that pointer itself, `up`'s own destructor must not also try to free it. The destructor side works exactly like `out_ptr`'s: at the end of the full expression, it calls `s.reset(p, args...)` with whatever ended up in the slot.

cppreference's equivalence example makes the release/reset bracket explicit. This:

```cpp
int foreign_resetter(T**);
std::unique_ptr<T, D> up;

if (int ec = foreign_resetter(std::inout_ptr(up)))
    return ec;
```

is roughly equivalent to:

```cpp
int foreign_resetter(T**);
std::unique_ptr<T, D> up;

T *raw_p = up.get();
up.release();
int ec = foreign_resetter(&raw_p);
up.reset(raw_p);
if (ec != 0)
    return ec;
```

Note what this expansion does _not_ say: it doesn't say `foreign_resetter` must free the old value and allocate a new one. It says `foreign_resetter` receives the old value and may do anything with it — reuse it unchanged, free it and write back something different, or free it and null the slot on failure. All three are handled correctly by the same release-before/reset-after bracket, because the bracket only cares about what ends up in `raw_p` when the call returns, not about how the C function got there. The genuinely defining trait of `inout_ptr` is simply this: the C function needs to see the existing value. Whatever it does with that value afterward is the C function's business.

`inout_ptr` is ill-formed for `shared_ptr` outright — there's no safe way to hand a shared owner's pointer to a function that might free it while other owners still believe they hold it.

## 3. FFmpeg with `out_ptr`: wrapping the alloc side

FFmpeg's C API has a `T**` idiom on both ends, and it's worth separating them before reaching for any adapter:

- **Freeing functions** take a `T**` so they can null the caller's pointer after freeing it — `av_frame_free(AVFrame**)`, `av_packet_free(AVPacket**)`, `avcodec_free_context(AVCodecContext**)`, `avformat_close_input(AVFormatContext**)`. This is a mismatch with `std::unique_ptr`'s deleter contract, which is called with a `T*`, not a `T**`. It has nothing to do with `out_ptr` — it's solved with a small deleter adapter, independently of anything below.
- **Allocating functions** that write through a `T**` output parameter — `avformat_open_input(AVFormatContext**, ...)` is the clearest example. This is exactly the shape `out_ptr` targets.

### The deleter adapter

A non-type template parameter collapses "wrap a `void f(T**)` free function as a `unique_ptr` deleter" into one line per type:

```cpp
template <auto Free>
struct Deleter {
    template <typename T>
    void operator()(T* p) const noexcept { Free(&p); }
};

using FramePtr        = std::unique_ptr<AVFrame,         Deleter<av_frame_free>>;
using PacketPtr       = std::unique_ptr<AVPacket,        Deleter<av_packet_free>>;
using CodecContextPtr = std::unique_ptr<AVCodecContext,  Deleter<avcodec_free_context>>;
using InputContextPtr = std::unique_ptr<AVFormatContext, Deleter<avformat_close_input>>;
```

`Deleter<Free>` is stateless — `Free` is captured as a compile-time non-type template argument, not stored as a member — so `sizeof(Deleter<...>) == 1` and `unique_ptr`'s empty-base optimization applies: `sizeof(FramePtr) == sizeof(void*)`, no overhead over a raw pointer. This deleter lives entirely in the smart pointer's type and is completely independent of `out_ptr` — `out_ptr` never sees it; it only calls `reset()`, and `reset()` invokes whatever deleter the type already carries.

### `avformat_open_input` with `out_ptr`

```c
int avformat_open_input(AVFormatContext **ps, const char *url,
                         const AVInputFormat *fmt, AVDictionary **options);
```

The common call site always starts from an empty smart pointer — there's no existing context to hand in, which is exactly the shape `out_ptr` is built for:

```cpp
InputContextPtr ctx; // deleter already baked into the type
int ret = avformat_open_input(std::out_ptr(ctx), url, nullptr, nullptr);
if (ret < 0) {
    // avformat_open_input frees the context itself and writes NULL;
    // out_ptr's destructor then calls ctx.reset(nullptr) — a no-op.
    return ret;
}
// ctx now owns the context; avformat_close_input runs automatically
// whenever ctx goes out of scope.
```

### `AVFrame`, `AVPacket`, `AVCodecContext`: no `out_ptr` needed

Most of FFmpeg's everyday allocators — `av_frame_alloc`, `av_packet_alloc`, `avcodec_alloc_context3` — return `T*` directly. There's no `T**` output parameter to adapt, so construction is ordinary:

```cpp
FramePtr        frame(av_frame_alloc());
PacketPtr       pkt(av_packet_alloc());
CodecContextPtr cctx(avcodec_alloc_context3(codec));
```

The lesson generalizes: scan specifically for functions taking `Type**` as an _out_ parameter, not every function that deals in `Type*`. `out_ptr` has nothing to adapt when the allocator already returns the pointer directly.

## 4. `inout_ptr` with an invented C API

FFmpeg doesn't have a public function with the shape `inout_ptr` was designed around — one that reads an existing pointer and, as part of its normal contract, frees it and allocates a replacement. The closest-looking candidates (`avformat_open_input`, `swr_alloc_set_opts2`) actually reuse an existing, non-null resource in place on success and only free-and-null it on error, which `out_ptr` already handles correctly without needing to see the old value at all. So here's a small invented C API that has the textbook shape, to show `inout_ptr` doing the thing it's actually for:

```c
// resource.h — hypothetical C library
typedef struct resource resource_t;

// If *pres is non-NULL, the existing resource is destroyed and a new
// one is allocated with the given configuration. If *pres is NULL,
// a new resource is allocated directly. On failure, *pres is set to
// NULL and the old resource (if any) has already been destroyed.
int resource_reconfigure(resource_t** pres, int flags);
void resource_destroy(resource_t* res);
```

Before C++23:

```cpp
resource_t* raw = existing.release(); // hand over ownership first —
                                      // resource_reconfigure may free it
int ec = resource_reconfigure(&raw, new_flags);
existing.reset(raw); // owns the replacement, or nothing on failure
if (ec != 0) return ec;
```

Three separate steps again, and getting the order wrong — resetting before the call, say, or forgetting `release()` — reintroduces a double-free or a leak. With `inout_ptr`:

```cpp
using ResourcePtr = std::unique_ptr<resource_t, Deleter<resource_destroy>>;

ResourcePtr existing = /* ...owns a previously configured resource... */;
int ec = resource_reconfigure(std::inout_ptr(existing), new_flags);
if (ec != 0) return ec;
// existing now owns the replacement resource.
```

`inout_ptr(existing)`'s constructor calls `existing.release()` and seeds the temporary with the pointer that returns, so `resource_reconfigure` sees the real, existing resource through `pres` — exactly what it needs to destroy it. Its destructor then calls `existing.reset(...)` with whatever `resource_reconfigure` wrote back: the new resource on success, or `nullptr` on failure. The deleter adapter from the FFmpeg section — `Deleter<Free>` wrapping a `void f(T**)`-shaped destroy function — applies here too, unchanged; `resource_destroy` happens to take a plain `T*`, so a direct non-template deleter would work as well, but reusing the same `Deleter<Free>` keeps the two call sites consistent even though one wraps a `T**` free function and the other a `T*` one (`Deleter<Free>`'s `operator()` always takes `T*` and forms `&p` itself, regardless of what `Free` ultimately needs).

Starting from an empty `ResourcePtr` works too — `resource_reconfigure` simply sees `NULL` and allocates fresh, matching its documented `*pres == NULL` branch — but there is no reason to prefer `out_ptr` there over `inout_ptr`: with an empty smart pointer, `release()` is a no-op, so `inout_ptr` costs nothing extra and stays correct if the call site later gets a pre-populated pointer. `out_ptr` is the right default specifically when the function's contract guarantees it never reads the existing value — for `resource_reconfigure`, it does, so `inout_ptr` is the adapter that matches the documented contract regardless of which case a given call happens to hit.

## 5. Summary

- `out_ptr_t`'s temporary always starts **empty** (value-initialized), regardless of what the smart pointer held before the call; its destructor calls `reset()` unconditionally with whatever the C function wrote back.
- `inout_ptr_t`'s constructor calls `release()` and seeds the temporary with the **existing** pointer, so the C function can read it; its destructor calls `reset()` the same way `out_ptr_t`'s does.
- The dividing line between them is not "does the function free and reallocate" — it's **does the function need to see the value that's already there**. A function that always starts from a null slot never needs `inout_ptr`; a function that reads `*ps` as an input, for whatever reason, does.
- `shared_ptr` requires an explicit deleter argument with `out_ptr` (enforced by a `static_assert`) and isn't supported by `inout_ptr` at all.
- In FFmpeg specifically: allocating functions with a `T**` out-parameter (`avformat_open_input`) are the `out_ptr` case; functions whose allocators return `T*` directly (`av_frame_alloc`, `av_packet_alloc`, `avcodec_alloc_context3`) don't need `out_ptr` at all; and the freeing side (`av_frame_free`, `avformat_close_input`, ...) needs a deleter adapter regardless of either, because that's a separate problem — a `T*`-to-`T**` mismatch, not an allocation-time one.
- A non-type template parameter (`Deleter<Free>`) turns "adapter for a `void f(T**)` free function" into a one-line `using` declaration per type, at zero size overhead over a raw pointer.
