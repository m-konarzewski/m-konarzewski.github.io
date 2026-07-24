---
draft: false
date: 2026-07-23T10:00:00+02:00
title: "std::ios::sync_with_stdio: What it actually does and when it bites"
tags: ["C++", "iostream", "Performance", "stdio"]
categories: ["C++"]
---

`std::ios::sync_with_stdio(false)` is one of the most copy-pasted lines in
competitive programming and performance-sensitive C++ — usually dropped at
the top of `main()` with a comment like `// speed up cin/cout` and never
thought about again. It does make I/O faster. It also silently changes the
rules for mixing `printf`/`scanf` with `cin`/`cout`, and that trade-off is
almost never explained alongside the performance tip. This article covers
what the call actually does, why `iostream` is slow by default in the first
place, and the specific ways this "free" optimization stops being free.

## Why `iostream` is slow to begin with

By default, C++'s `iostream` objects (`cin`, `cout`, `cerr`, `clog`) are
synchronized with C's `stdio` streams (`stdin`, `stdout`, `stderr`). This
synchronization is what lets you freely interleave `printf` and `std::cout`
in the same program and get output in the order you wrote it:

```cpp
printf("first\n");
std::cout << "second\n";
printf("third\n");
// guaranteed order: first, second, third
```

To guarantee that ordering, every `iostream` operation has to coordinate
with the C stdio buffers underneath it — in most implementations this means
`iostream` doesn't get its own independent buffer at all; it goes through
`stdio`'s buffering, plus its own locking and formatting layer on top. That
coordination is the tax you pay on every single `<<` and `>>`, whether or
not your program ever calls `printf`.

## What the call actually turns off

```cpp
std::ios::sync_with_stdio(false);
```

This breaks the synchronization. After this call, `cin`/`cout` get their
own independent buffers, decoupled from `stdio`. Two consequences follow
directly from that:

- **`iostream` operations get noticeably faster**, because they no longer
  coordinate with `stdio` on every call — often a measurable win in tight
  loops doing lots of small reads or writes.
- **Interleaving with `printf`/`scanf` is no longer ordered.** The two
  streams now buffer independently, and output can appear in an order that
  has nothing to do with the order you wrote the calls in.

```cpp
std::ios::sync_with_stdio(false);

printf("first\n");
std::cout << "second\n";
printf("third\n");
// order is no longer guaranteed — could print as
// second, first, third — or any other interleaving
```

This is the entire trade: you give up guaranteed ordering between the two
I/O systems in exchange for `iostream` not having to pay for that guarantee
on every operation.

## The mixed-stream bug this actually causes

The failure mode isn't usually "output looks weird in a toy example" — it's
subtler and shows up in real code that mixes styles for legitimate reasons
(e.g. using `scanf` for fast parsing in one function and `cin` elsewhere):

```cpp
std::ios::sync_with_stdio(false);

int n;
std::cin >> n;

char buf[64];
scanf("%63s", buf); // reads from a buffer that cin's read didn't flush/sync with

std::cout << n << " " << buf << '\n';
```

Once synchronization is off, `cin` and `scanf` are drawing from
_independent_ buffered views of the same underlying file descriptor. Data
`cin` has already buffered but not yet consumed isn't visible to `scanf`,
and vice versa — you can end up skipping input, reading stale data, or
getting `scanf` to block waiting for input that's already sitting in
`cin`'s buffer. This is a correctness bug, not a formatting quirk, and it's
much harder to spot than the ordering example above because it depends on
exactly where the buffer boundaries land.

**Fix:** once you call `sync_with_stdio(false)`, commit to one I/O family
for the rest of the program — either `iostream` everywhere, or C `stdio`
everywhere. Don't mix them, and definitely don't mix them for stdin
parsing specifically, where the buffering interaction is the most fragile.

## `cin.tie(nullptr)` — the optimization's usual companion

`sync_with_stdio(false)` almost always shows up next to another line:

```cpp
std::ios::sync_with_stdio(false);
std::cin.tie(nullptr);
```

By default, `cin` is _tied_ to `cout`: every read from `cin` first flushes
`cout`, so a prompt like `std::cout << "Enter value: ";` is guaranteed to
be visible before the program blocks waiting for input. That's a
correctness feature for interactive programs, and it costs a flush on
every single read.

`cin.tie(nullptr)` breaks that tie. Reads no longer force a flush of
`cout`, which matters when a program does many reads with only occasional
output — but it means prompts printed right before a read are no longer
guaranteed to appear before the program blocks. For interactive CLI tools
this is a real UX regression; for batch-processing large input (the usual
target of this optimization) it's irrelevant because there's no
interactive prompt to lose.

**Fix:** use `cin.tie(nullptr)` for batch/offline programs that consume
large input without interleaved prompts. Leave the default tie in place —
or `endl`/explicitly `flush()` where it matters — for anything interactive.

## Does it actually matter for your program?

The realistic performance picture:

- For programs doing a handful of reads and writes, the difference is
  unmeasurable — the synchronization overhead is a per-call constant, and
  a constant times a small number is still small.
- For programs doing tight loops of many small `cin >>`/`cout <<`
  operations — the classic competitive-programming pattern of reading
  10⁶ integers — the difference is very real and commonly cited as an
  order-of-magnitude improvement in I/O-bound benchmarks.
- `std::endl` is a separate, often bigger cost than the sync flag: it
  flushes the stream on every call, which is a much heavier operation than
  the synchronization overhead itself. A loop full of `std::endl` will
  dominate the profile regardless of `sync_with_stdio`. Prefer `'\n'` and
  let the stream flush on its own schedule (or flush explicitly, once, at
  the points that actually need it).

**Fix:** profile before reaching for this as a default. It's a legitimate,
well-known optimization for I/O-bound batch programs — but treat it as a
deliberate choice with a real trade-off, not a boilerplate line every
`main()` should start with.

## A note on thread safety

Synchronized `iostream`/`stdio` operations are also implicitly serialized
with respect to each other in ways that matter for multi-threaded programs
mixing both APIs. Once desynchronized, that's no longer guaranteed either —
one more reason the "always add this line" advice deserves more scrutiny
than it usually gets in a program that isn't a single-threaded,
input-bound loop.

## Summary

`sync_with_stdio(false)` is a real, well-understood performance win for the
specific case it targets: large volumes of `iostream`-only I/O, with no
interleaved `stdio` calls. Outside that case — interactive programs, code
that mixes `cin`/`scanf`, or programs where I/O isn't the bottleneck — it
either does nothing useful or actively introduces bugs that are unpleasant
to track down precisely because they depend on buffer timing rather than
program logic. Use it deliberately, pair it with `cin.tie(nullptr)` only
when the interactivity trade-off is acceptable, and never mix `iostream`
and `stdio` on the same stream once it's on.
