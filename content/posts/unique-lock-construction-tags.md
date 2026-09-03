+++ 
draft = false
date = 2026-08-18T10:02:26+02:00
title = "std::unique_lock and Its Three Construction Tags"
tags = ["C++", "unique-lock", "tags", "mutex"]
categories = ["C++"]
+++

## 1. Introduction

`std::unique_lock` is the more flexible sibling of `std::lock_guard`: both are RAII wrappers around a mutex — the same idiom covered in depth in the earlier post on RAII, applied specifically to `lock()`/`unlock()` as the acquire/release pair — but `unique_lock` trades a small amount of overhead for a much larger set of capabilities. Where `lock_guard` does exactly one thing (lock on construction, unlock on destruction, nothing else), `unique_lock` can defer locking, attempt it without blocking, adopt a lock someone else already took, unlock and relock mid-scope, and be moved out of a function. Three tag types — `std::defer_lock`, `std::try_to_lock`, and `std::adopt_lock` — control exactly what happens at construction time, and this post works through each one.

## 2. Default construction: lock immediately

The default behavior mirrors `lock_guard` exactly:

```cpp
std::mutex mtx;

void critical_section() {
    std::unique_lock<std::mutex> lock(mtx);   // blocks until mtx is acquired
    // ... protected work ...
}   // mtx released automatically when lock goes out of scope
```

No tag, no surprises — construction blocks until the mutex is acquired, and destruction releases it. Everything from here on is about what happens when you pass one of the three tags as a second constructor argument, changing that default behavior deliberately.

## 3. Tag 1: `std::defer_lock`

`std::defer_lock` constructs the `unique_lock` _without_ locking the mutex at all. The `unique_lock` object exists, associated with the mutex, but ownership of the lock hasn't been acquired yet — `owns_lock()` is `false` immediately after construction.

```cpp
std::mutex mtx_a, mtx_b;

void transfer() {
    std::unique_lock<std::mutex> lock_a(mtx_a, std::defer_lock);
    std::unique_lock<std::mutex> lock_b(mtx_b, std::defer_lock);

    std::lock(lock_a, lock_b);   // locks both, deadlock-avoiding algorithm
    // ... both mutexes now held, safe to access data under both ...
}   // both released automatically, in reverse order, when locks go out of scope
```

The canonical use case is locking multiple mutexes together safely. Locking two mutexes one at a time — `mtx_a.lock(); mtx_b.lock();` — is a classic deadlock setup if some other thread locks them in the opposite order. `std::lock()` (the free function, not the member function) takes multiple lockable objects and acquires all of them using a deadlock-avoidance algorithm, but it needs objects that are _already constructed but not yet locked_ to operate on — which is exactly what `defer_lock` gives you. The `unique_lock` objects themselves still guarantee RAII-correct release on scope exit; you've just decoupled construction from the actual locking step to let `std::lock()` handle acquisition order for you.

## 4. Tag 2: `std::try_to_lock`

`std::try_to_lock` attempts to acquire the mutex via `try_lock()` — a non-blocking attempt that returns immediately whether or not the lock was obtained — rather than blocking until it succeeds.

```cpp
void attempt_work() {
    std::unique_lock<std::mutex> lock(mtx, std::try_to_lock);

    if (lock.owns_lock()) {
        // acquired it — proceed with the protected work
        do_work();
    } else {
        // someone else holds the mutex right now — fall back instead of blocking
        do_fallback_work();
    }
}
```

This is the tool for code that has something useful to do if a lock isn't immediately available, rather than blocking and waiting — a background maintenance task that can skip this cycle if the relevant data is currently busy, for instance, rather than stalling a thread that has better things to do. Checking `owns_lock()` immediately after construction isn't optional here — unlike the default or `adopt_lock` cases, `try_to_lock` construction can legitimately leave the `unique_lock` _not_ owning the lock, and proceeding as if it does is a straightforward correctness bug, not a rare edge case.

## 5. Tag 3: `std::adopt_lock`

`std::adopt_lock` tells the `unique_lock` "this mutex is already locked — by you, the calling thread, right now — just take over responsibility for unlocking it later." No lock or try_lock happens at construction; the `unique_lock` immediately considers itself the owner.

```cpp
void manual_then_raii() {
    mtx.lock();   // locked manually, outside of any RAII wrapper — for whatever reason

    std::unique_lock<std::mutex> lock(mtx, std::adopt_lock);
    // lock now owns responsibility for unlocking mtx, without having locked it itself
    // ... protected work ...
}   // mtx released automatically here
```

The realistic scenario is exactly this: a mutex was locked directly, outside of any RAII wrapper — often because it's inherited from an API boundary, or because `std::lock()` (Section 3's multi-mutex deadlock-avoidance function) already acquired it as part of locking several mutexes together and you now want each one wrapped in its own `unique_lock` for automatic release without re-locking anything. `adopt_lock` is precisely the connective tissue between "a mutex got locked by some means outside of RAII" and "now RAII owns its release."

The sharp edge here is exactly what you'd expect: `adopt_lock` performs **no verification** that the mutex is actually locked. If you construct a `unique_lock` with `adopt_lock` on a mutex that isn't currently locked by the calling thread, you get undefined behavior the moment the `unique_lock` is destroyed and calls `unlock()` on something it never locked.

## 6. Comparison with `lock_guard` and `scoped_lock`

`lock_guard` doesn't offer any of these three tags because it doesn't need the flexibility they provide — `lock_guard` is deliberately minimal: lock on construction, unlock on destruction, full stop, with no `owns_lock()`, no deferred locking, no move support. That minimalism isn't a limitation so much as a design choice — when you genuinely only need "lock this one mutex for the scope of this block," `lock_guard` expresses exactly that intent with the least possible overhead and the fewest ways to misuse it.

For the specific multi-mutex, deadlock-avoiding scenario from Section 3, C++17's `std::scoped_lock` is usually the better modern choice over a pair of `defer_lock`-tagged `unique_lock`s:

```cpp
// unique_lock + defer_lock + std::lock (pre-C++17 idiom)
std::unique_lock<std::mutex> lock_a(mtx_a, std::defer_lock);
std::unique_lock<std::mutex> lock_b(mtx_b, std::defer_lock);
std::lock(lock_a, lock_b);

// scoped_lock (C++17): identical guarantee, one line
std::scoped_lock lock(mtx_a, mtx_b);
```

`scoped_lock` takes any number of mutexes directly in its constructor and internally applies the same deadlock-avoidance algorithm `std::lock()` uses, with no separate `defer_lock` dance required. Reach for `unique_lock` with `defer_lock` specifically when you need the resulting lock objects to individually support the extra `unique_lock` capabilities from Section 7 below (moving one out, unlocking mid-scope) — otherwise `scoped_lock` says exactly what you mean with less code.

## 7. Flexibility beyond construction

The capabilities that justify `unique_lock`'s extra overhead over `lock_guard` mostly show up _after_ construction, not at it. `unique_lock` exposes `lock()`, `unlock()`, and `try_lock()` as ordinary member functions, meaning you can release and reacquire the mutex within the same scope:

```cpp
void mixed_work() {
    std::unique_lock<std::mutex> lock(mtx);
    do_protected_work();

    lock.unlock();       // release early — the next part doesn't need protection
    do_unprotected_work();

    lock.lock();          // reacquire before touching shared state again
    do_more_protected_work();
}   // released automatically at scope exit, whatever the current owns_lock() state
```

`unique_lock` is also move-only (true to its name — at most one `unique_lock` owns a given lock at a time, but that ownership is transferable), which means it can be returned from a factory function or stored in a container, unlike `lock_guard`, which is neither movable nor copyable.

This combination — releasable, reacquirable, and movable — is exactly why `std::condition_variable::wait()` requires a `unique_lock<std::mutex>` specifically, and won't accept a `lock_guard`. `wait()` needs to atomically unlock the mutex while the calling thread sleeps, and relock it before returning — a release-then-reacquire sequence in the middle of the object's lifetime that `lock_guard`'s fixed lock-once/unlock-once contract simply can't express.

## 8. Pitfalls

**Forgetting to check `owns_lock()` after `try_to_lock`.** As flagged in Section 4, this is the single most common bug with this tag — proceeding into protected work as if the lock was acquired, when `try_to_lock` construction can legitimately fail to acquire it. Unlike the default constructor, which blocks until success and therefore never leaves you in this ambiguous state, `try_to_lock` construction always requires this explicit check.

**Using `adopt_lock` on a mutex that isn't actually locked.** Section 5 already covered the mechanism — this is worth restating as the pitfall it is, because the bug doesn't manifest at the `adopt_lock` call site; it manifests later, at destruction, as undefined behavior from unlocking a mutex the current thread never actually held. There's no defensive check available here — `adopt_lock` trusts the caller completely, by design, since verifying "is this mutex currently locked by me" isn't something the standard mutex interface can even answer.

**Paying `unique_lock`'s overhead when `lock_guard` would do.** `unique_lock` carries extra state — at minimum, an owns/doesn't-own flag, since unlike `lock_guard` its ownership state can change over its lifetime — and that extra state is a small but real, measurable cost in code that locks and unlocks a single mutex in a tight loop with no need for any of `unique_lock`'s extra capabilities. If nothing in Sections 3–7 applies to a given use — no deferred locking, no try-lock, no adoption, no mid-scope unlock/relock, no `condition_variable`, no need to move the lock out of the function — `lock_guard` is the right default, not `unique_lock` used out of habit.

## 9. Summary

`std::unique_lock` generalizes `std::lock_guard`'s fixed lock-on-construct/unlock-on-destruct contract into something considerably more flexible, and its three construction tags each unlock a specific capability: `defer_lock` postpones locking so `std::lock()` (or, more often in modern code, `scoped_lock`) can acquire multiple mutexes safely; `try_to_lock` attempts a non-blocking acquisition, requiring an explicit `owns_lock()` check afterward; and `adopt_lock` takes over responsibility for a mutex some other code already locked, with zero verification that it actually was. Beyond construction, `unique_lock`'s ability to unlock, relock, and be moved is what specifically makes it — and not `lock_guard` — the type `std::condition_variable::wait()` requires. Reach for `lock_guard` by default, and reach for `unique_lock` specifically when one of these extra capabilities is actually needed, not as a habitual, slightly-more-expensive substitute.
