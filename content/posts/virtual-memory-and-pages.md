+++ 
draft = false
date = 2026-09-15T09:08:59+02:00
title = "Virtual memory and pages"
tags = ["linux", "virtual-memory", "memory-pages", "page-tables"]
categories = ["Linux"]
+++

# How linux actually manages address space for C/C++ programs

Every pointer you've ever dereferenced in a C or C++ program is a lie, in the most useful possible sense. The address in that pointer is not a physical RAM location — it's a virtual address, and there's an entire hardware/kernel machinery standing between it and the actual DRAM cell it eventually resolves to. This post is about that machinery: pages, page tables, the TLB, and what demand paging and copy-on-write mean for code you actually write.

## 1. Why virtual memory exists at all

Three problems virtual memory solves simultaneously:

**Isolation.** If processes addressed physical RAM directly, any process could read or corrupt any other process's memory just by picking the right address. Virtual memory gives each process its own address space, translated independently, so a pointer bug in one process can't reach into another's.

**A simpler illusion.** Each process gets to believe it owns a large, contiguous address range (on x86-64, up to 128 TiB of user-space virtual address, in the classic 48-bit canonical layout) regardless of how physical RAM is actually fragmented or how much of it exists. Your allocator doesn't need to know or care where in physical RAM its pages happen to land.

**Overcommit and lazy allocation.** The kernel can hand out virtual address ranges (via `mmap`, via the heap) without immediately backing them with physical RAM, and only actually allocate physical pages when they're first touched. This is what makes large sparse allocations, `fork()`, and memory-mapped files cheap.

The mechanism that makes all three possible is a layer of indirection: every memory access goes through address translation, virtual → physical, enforced by the CPU's memory management unit (MMU) consulting kernel-maintained page tables.

## 2. Pages: the unit of everything

Virtual memory isn't tracked byte by byte — it's tracked in fixed-size chunks called **pages**. On x86-64 and ARM64, the default page size is **4 KiB**. Every mapping, every permission bit, every present/absent state applies to a whole page, not individual bytes.

Why fixed-size pages instead of, say, variable-size segments (which older architectures did use)? A fixed granularity makes the translation structures (page tables) simple, fast to walk, and free of external fragmentation at the allocation level — you're always dealing in page-sized units, so there's no "hole" of odd size left behind the way there can be with variable-size heap allocations.

### Huge pages

4 KiB is small enough that a program using gigabytes of memory needs millions of page table entries, and every one of those potentially needs a slot in the CPU's translation cache (the TLB, covered below). **Huge pages** — 2 MiB or 1 GiB on x86-64 — trade granularity for fewer entries: a 1 GiB huge page covers what would otherwise be 262,144 standard 4 KiB pages, using a single TLB entry instead.

You can request huge pages explicitly (`mmap` with `MAP_HUGETLB`, or `madvise(addr, len, MADV_HUGEPAGE)` to opt an existing mapping into **Transparent Huge Pages**, THP, which lets the kernel opportunistically back it with huge pages without you managing a separate hugetlbfs pool). The tradeoff is internal fragmentation — if you only touch a few KiB inside a 2 MiB huge page, you're still consuming the whole 2 MiB of physical RAM — which is why huge pages are a net win for large, densely-used allocations (databases, JVM heaps, large matrix workloads) and a net loss for many small, sparse ones.

## 3. Page tables: the translation mechanism

The structure that maps virtual pages to physical pages is the **page table**, walked by the MMU on every memory access. A flat, single-level table mapping every possible virtual page directly would be enormous — even restricting to the 48-bit canonical address space, a single-level table would need 2^36 entries. So Linux on x86-64 uses a **multi-level (radix) page table**, currently 4 levels by default (5 levels, enabling 57-bit addressing, on newer CPUs with `la57` support and kernels configured for it):

```
PGD (Page Global Directory)  → PUD (Page Upper Directory)
    → PMD (Page Middle Directory) → PTE (Page Table Entry)
```

A 64-bit virtual address is sliced into fields that index into each level in turn:

```
 63        48 47    39 38    30 29    21 20    12 11         0
+-----------+--------+--------+--------+--------+-------------+
| unused/   |  PGD   |  PUD   |  PMD   |  PTE   | page offset |
| sign ext. |  idx   |  idx   |  idx   |  idx   |  (12 bits)  |
+-----------+--------+--------+--------+--------+-------------+
```

Translating a virtual address means: read `CR3` to find the PGD's physical base, index into it with bits [47:39] to get the PUD's physical address, index into that with bits [38:30] for the PMD, then [29:21] for the PTE, and finally the PTE holds the physical page's base address, to which the low 12 bits (the page offset) are appended directly. That's up to four sequential memory reads just to resolve one address — which is exactly why this path is cached (see the TLB section next).

Each **page table entry** carries more than just a physical address — it has flag bits the MMU checks on every access:

- **Present** — is this virtual page currently mapped to a physical page at all? If not, any access triggers a page fault.
- **R/W** — writable, or read-only (used for `mprotect(PROT_READ)`, and for copy-on-write, see below).
- **User/Supervisor** — accessible from ring 3, or kernel-only (this is the exact bit that made kernel-mapped-but-inaccessible pages possible in the last post).
- **NX (No-Execute)** — this page cannot be executed as instructions, a core mitigation against exploiting buffer overflows by jumping into injected data (paired with `mprotect(PROT_EXEC)` and W^X policies your linker/loader already enforce for you).
- **Accessed / Dirty** — set by the CPU automatically on read/write, used by the kernel's page reclaim logic to decide which pages have been recently used (accessed) or modified and need writeback before reclaim (dirty).

## 4. The TLB and why it matters for your code's performance

A four-level page table walk on every single memory access would be a disaster for performance — you'd turn one memory access into up to five. The **Translation Lookaside Buffer (TLB)** is a small, fast, on-core cache of recent virtual→physical translations. On a TLB hit, the MMU skips the page table walk entirely and gets the physical address directly.

This has a very direct consequence for how you write performance-sensitive C/C++: **access patterns that touch many distinct pages sparsely thrash the TLB**, while sequential or well-localized access patterns reuse the same small set of TLB entries repeatedly. This is one of the concrete, measurable reasons "cache-friendly" and "TLB-friendly" data layout (structure-of-arrays over array-of-structures for large hot datasets, iterating matrices in memory order, sizing working sets to fit within what your TLB can cover) shows up as a real speedup, distinct from and in addition to ordinary L1/L2/L3 cache locality effects.

You can observe this directly:

```bash
$ perf stat -e dTLB-load-misses,dTLB-store-misses,page-faults ./your_program
```

Huge pages reduce TLB pressure precisely because each entry covers far more address space — a working set that needs thousands of 4 KiB TLB entries might need only a handful of 2 MiB entries, which is why database engines and JVMs that touch large heaps aggressively push for huge-page backing.

Tying back to the last post: this is also why a full process context switch (a `CR3` reload) is so much more expensive than a syscall mode-switch alone. On older CPUs, reloading `CR3` invalidates the entire TLB, forcing every subsequent access to pay the full page-table-walk cost again until it re-warms. Modern CPUs mitigate this with **PCID** (Process-Context Identifiers), letting the TLB tag entries by address-space ID so a `CR3` switch doesn't have to flush everything — but the cost is reduced, not eliminated.

## 5. A process's address space layout, concretely

A typical Linux process's virtual address space, from low to high addresses, looks roughly like this:

```
0x000000000000  ┌─────────────────────┐
                 │  (unmapped guard)   │
0x000000400000  ├─────────────────────┤
                 │  .text (code)       │
                 │  .rodata            │
                 │  .data / .bss       │
                 ├─────────────────────┤
                 │  heap (grows up ↑)  │
                 │        ...          │
                 │   (unmapped gap)    │
                 │        ...          │
                 │  mmap region        │
                 │  (shared libs,      │
                 │   anonymous mmaps,  │
                 │   file mappings)    │
                 ├─────────────────────┤
                 │  stack (grows ↓)    │
0x7ffffffff000  └─────────────────────┘
                 (kernel space above, as covered last post)
```

- **.text** holds executable code, mapped read+execute, not writable — this is the NX/W^X boundary at work.
- **.data/.bss** hold initialized and zero-initialized static/global variables.
- The **heap** grows via `brk()`/`sbrk()` historically, though modern glibc malloc uses `mmap` directly for large allocations (above `M_MMAP_THRESHOLD`, 128 KiB by default) rather than growing the brk heap for everything.
- The **mmap region** is where shared libraries get loaded, where `mmap()` calls in your own code land, and where large heap allocations end up.
- The **stack** grows downward from a high address, with a guard region below it to catch overflow.

You can see this for real, for any running process:

```bash
$ cat /proc/self/maps
555555554000-555555555000 r--p 00000000 08:01 1234  /path/to/binary
555555555000-555555556000 r-xp 00001000 08:01 1234  /path/to/binary
...
7ffff7dc0000-7ffff7de3000 r--p 00000000 08:01 5678  /usr/lib/libc.so.6
...
7ffffffde000-7ffffffff000 rw-p 00000000 00:00 0     [stack]
```

Each line is one mapping with its permission bits (`r`/`w`/`x`, and `p`/`s` for private/shared) — directly the R/W and NX bits from the page tables, made visible.

### ASLR

Notice that the exact addresses above aren't fixed — **Address Space Layout Randomization** randomizes the base addresses of the stack, heap, mmap region, and (with PIE binaries, the default on modern distros) even the executable's own load address, on every process start. This doesn't stop memory-corruption bugs from existing, but it defeats exploits that hardcode addresses (e.g. jumping to a known libc function via ROP), by making the addresses unpredictable per run. It's a mitigation, not a fix — hence pairing with NX, stack canaries, and W^X.

## 6. Demand paging and page faults

Here's the part that surprises people coming from a "memory = physically there" mental model: **calling `mmap()` or having the heap grow doesn't mean physical RAM is immediately allocated.** The kernel updates the page tables to mark a range as valid virtual address space, but many of those pages start out **not present** — no physical page assigned yet. Physical allocation happens lazily, on first touch, via a **page fault**.

Two broad categories:

**Minor fault** — the page fault handler can satisfy the fault without going to disk. Common causes: first touch of a freshly `mmap(MAP_ANONYMOUS)`'d page (kernel finds/zeroes a physical page and updates the PTE), or a copy-on-write fault (see below), or touching a page that's already in the page cache from another mapping.

**Major fault** — the handler has to actually read from a block device (disk/SSD) to satisfy it, typically because the page belongs to a file-backed mapping whose data isn't yet in the page cache, or because the page was swapped out. Major faults are orders of magnitude slower than minor ones, since they involve I/O.

You can watch this happen:

```c
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    size_t len = 100 * 1024 * 1024; // 100 MiB
    char *p = mmap(NULL, len, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    // At this point, VmRSS in /proc/self/status barely moved —
    // the mapping exists, but no physical pages are backing it yet.
    system("grep VmRSS /proc/self/status");

    // Touch every page (4 KiB apart) to force minor faults:
    for (size_t i = 0; i < len; i += 4096)
        p[i] = 1;

    // Now VmRSS should have grown by roughly the full 100 MiB.
    system("grep VmRSS /proc/self/status");
    return 0;
}
```

Run that under `strace -c` and you won't see per-page syscalls — the page faults are handled entirely inside the kernel's fault handler, triggered by the CPU trapping the access, not by an explicit syscall from your code.

### Copy-on-write and why `fork()` is cheap

`fork()` needs to give the child process what looks like a complete, independent copy of the parent's entire address space. Actually copying every page immediately would be enormously wasteful, especially since most `fork()`+`exec()` patterns throw the copy away within microseconds. Instead, Linux uses **copy-on-write (COW)**:

1. `fork()` creates a new set of page tables for the child, but points them at the _same physical pages_ as the parent.
2. Every one of those shared pages is marked read-only in both parent's and child's page tables, regardless of their original permissions.
3. As long as neither process writes to a shared page, no copying ever happens — they're genuinely sharing physical RAM.
4. The moment either process writes to one of those pages, the write triggers a page fault (because the PTE says read-only), the kernel's fault handler allocates a fresh physical page, copies the data, updates that process's PTE to point at the new page with write permission restored, and only then lets the write proceed.

This is why `fork()` is fast even for processes with large address spaces, and it's the mechanism behind preforking server designs (Apache's prefork MPM, various database and app-server architectures): fork a worker per request/connection, and the OS itself keeps memory sharing cheap for the common case where most pages are never written after the fork.

## 7. `mmap` from the C/C++ programmer's side

Two broad flavors:

**Anonymous mapping** — no backing file, effectively a request for zero-filled pages, used for large heap-like allocations:

```c
void *buf = mmap(NULL, size, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
```

**File-backed mapping** — the pages are backed by a file's contents, and changes to a `MAP_SHARED` mapping are (eventually) written back to the file, via the page cache:

```c
int fd = open("data.bin", O_RDWR);
void *buf = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
```

Key distinctions that matter in practice:

- **`MAP_PRIVATE` vs `MAP_SHARED`** — private mappings get copy-on-write semantics per-process (your writes are invisible to other mappers of the same file, and never written back); shared mappings mean writes are visible to every other mapper and eventually flushed to the backing file.
- **`MAP_POPULATE`** — pre-faults all pages at mmap time instead of lazily, trading a slower `mmap()` call for avoiding fault latency later on first access — useful when you know you'll touch the whole region soon and want predictable per-access latency.
- **`mprotect()`** — changes permission bits on an existing mapping after the fact (e.g. marking a region read-only after initialization, or making a JIT code buffer executable only once code generation is complete — again, in service of W^X).

### Why allocators use `mmap` directly for large requests

glibc's `malloc` uses `sbrk`-extended heap memory for small allocations, but routes large ones (by default, requests ≥ 128 KiB, tunable via `mallopt(M_MMAP_THRESHOLD, ...)`) straight to `mmap`. Two reasons: a single huge allocation on the brk heap could get stuck behind a small live allocation at a higher address, since the heap can only grow/shrink from one end (fragmentation risk), while `mmap`-backed allocations can be returned to the kernel individually via `munmap` regardless of what else is allocated. Custom arena allocators in performance-sensitive C++ code often do the same thing deliberately — reserve address space with `mmap`, then manage suballocation themselves.

## 8. Swapping and memory pressure

When physical RAM is fully committed and more is needed, the kernel can **swap** — write the contents of rarely-used pages out to a swap device/file, freeing the physical page for something else, then read them back in (as a major fault) if they're touched again. The **Accessed** and **Dirty** PTE bits from section 3 are exactly what the kernel's page reclaim logic (the LRU lists it maintains per zone) uses to decide which pages are good swap-out candidates — clean, rarely-accessed pages first.

Swapping is a last resort in practice — its latency (milliseconds on a spinning disk, still meaningfully slower than RAM even on NVMe) is why sustained swapping ("thrashing") tanks throughput far more than the numbers might suggest at a glance. When the system is under severe enough memory pressure that swap can't keep up, the **OOM killer** steps in and forcibly kills a process (selected heuristically via each process's `oom_score`) to free memory rather than let the whole system grind to a halt — a topic large enough to deserve its own treatment, but worth knowing exists as the backstop.

## 9. Page state reference table

| State                | Meaning                                                                           | What triggers the transition into it                                           |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Unmapped             | No virtual→physical mapping exists; access faults with SIGSEGV                    | Initial state before `mmap`; after `munmap`                                    |
| Mapped, not resident | Virtual range reserved, PTE marked not-present, no physical page yet              | `mmap()` returns before any page is touched                                    |
| Resident, clean      | Physical page assigned, matches backing store (or is zero-fill), not yet modified | First touch (minor fault) of an anonymous or file-backed page                  |
| Resident, dirty      | Physical page modified since last sync with backing store                         | A write to a `MAP_SHARED` file-backed page, or any writable anonymous page     |
| Resident, COW-shared | Physical page shared read-only between parent/child post-`fork()`                 | `fork()`, before either side writes to the page                                |
| Swapped out          | Page contents written to swap, physical page freed for reuse                      | Kernel reclaim under memory pressure, targeting clean-first, LRU-ordered pages |

## 10. Practical takeaways for C/C++ developers

- **Prefer `mmap` over `malloc` for very large buffers** you'll size once and use for a while — you sidestep heap fragmentation, and can `madvise`/`mprotect` it precisely.
- **Sequential access beats random access** not just for cache locality but for TLB locality too — random access across a large sparse region can dominate runtime through TLB misses alone, independent of L1/L2/L3 effects.
- **`fork()` is cheap, but only if you don't write everywhere afterward** — COW makes preforking patterns efficient exactly to the extent that workers mostly read shared state and write to small, worker-local regions.
- **`perf stat -e page-faults,dTLB-load-misses`** is a quick, concrete way to tell whether a slow piece of code is memory-bound in the "layout is bad for the TLB/paging system" sense, distinct from being compute-bound or L1/L2-cache-bound.
- **Touching memory has a cost the first time, not before** — if you need predictable latency and can't tolerate a burst of minor faults mid-operation, `MAP_POPULATE` (or explicitly pre-touching pages) moves that cost earlier, to a point where it's acceptable.
