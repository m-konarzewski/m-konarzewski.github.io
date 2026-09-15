+++ 
draft = false
date = 2026-09-10T14:24:43+02:00
title = "User space vs. kernel space"
tags = ["linux", "user-space", "kernel-space", "syscalls"]
categories = ["Linux"]
+++

If you write C or C++ on Linux, you've been living on one side of a hard boundary your entire career, whether or not you've thought about it explicitly. Every `read()`, every `malloc()` that eventually needs more pages, every blocked `recv()` — all of it crosses, or almost crosses, a line enforced not by convention but by the CPU itself. This article is about that line: what it physically is, what it costs you, and where your code actually touches it.

## 1. The privilege boundary, concretely

"User space" and "kernel space" are not folders, and they're not just an OS-level abstraction like a namespace. They map onto a real hardware feature: CPU privilege levels.

On x86-64, the CPU supports four privilege rings (0–3), though Linux only uses two: **ring 0** for the kernel and **ring 3** for everything else. On ARM64, the equivalent concept is **exception levels** — EL0 for user space, EL1 for the kernel (EL2/EL3 are for hypervisors and secure firmware, generally invisible to you).

What does "privilege" actually gate? Concretely, at ring 3 the CPU will fault (`#GP`, general protection fault) if your code tries to:

- Execute privileged instructions — `hlt`, `cli`/`sti` (disable/enable interrupts), `lgdt`/`lidt` (load descriptor tables), `wrmsr` (write model-specific registers), `invlpg` (invalidate a TLB entry directly), `mov` to/from control registers like `CR3` (the page table base register).
- Access I/O ports directly with `in`/`out` (on architectures/configurations where that's gated by IOPL).
- Modify page table entries, since those live in kernel-owned physical pages that user page tables don't map writably.

This is why "kernel space" and "user space" is a hardware-enforced boundary, not a software convention you could bypass with a clever pointer cast. A wild pointer dereference in your C++ program can corrupt your own heap; it cannot, by itself, execute a privileged instruction or rewrite a kernel data structure, because the CPU simply refuses instructions like that at ring 3.

```c
// This will SIGSEGV (or on some configs, SIGILL) — not because the OS
// "checks" and denies it, but because the CPU traps on a privileged
// instruction executed at ring 3.
static inline void try_cli(void) {
    __asm__ volatile ("cli");
}
```

The kernel itself runs at ring 0 for exactly the opposite reason: it needs `cli`/`sti`, it needs to touch `CR3` on every context switch, it needs to program the interrupt controller. None of that is optional for an OS kernel.

## 2. How a process asks the kernel for anything: the syscall path

Since your ring-3 code can't just reach into kernel structures, every request to the kernel — open a file, allocate memory via `brk`/`mmap`, send a packet — goes through a syscall: a deliberate, controlled transition to ring 0.

### The mechanism

Historically x86 used a software interrupt, `int 0x80`, which is slow because interrupts route through the full IDT (interrupt descriptor table) machinery. Modern x86-64 uses a dedicated fast path: the `syscall` instruction (with `sysret` for the return), which reads a pre-configured target from the `IA32_LSTAR` MSR rather than walking interrupt tables. ARM64 uses `svc` (supervisor call).

What actually happens, roughly, on `syscall`:

1. CPU switches to ring 0, using RIP/RSP values the kernel pre-configured via MSRs at boot.
2. General-purpose registers holding your syscall number and arguments (on x86-64 System V: `rax` = syscall number, `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9` = args 1–6) are preserved.
3. The kernel's syscall entry stub saves the rest of user register state, then dispatches through `sys_call_table` indexed by the syscall number in `rax`.
4. The kernel handler runs (fully privileged, running on the _kernel_ stack for that thread, not your user stack).
5. Return value goes back in `rax`; `sysret` switches back to ring 3.

### Where libc fits in

You almost never invoke `syscall`/`svc` directly. When you call `read()`, `write()`, `open()`, you're calling a glibc (or musl) wrapper function. That wrapper's job is small but essential: marshal your arguments into the right registers, execute the `syscall` instruction, and translate a negative return value into `errno` plus a `-1` return, per POSIX convention (raw Linux syscalls just return `-errno` directly; they don't set a thread-local `errno` themselves — that translation is a libc-level convention).

You _can_ skip libc and issue a raw syscall yourself:

```c
#include <unistd.h>
#include <sys/syscall.h>

ssize_t raw_read(int fd, void *buf, size_t count) {
    return syscall(SYS_read, fd, buf, count);
}
```

This is useful in a few real situations: writing code that must not depend on libc being initialized (early in `_start`, or inside a signal handler where reentrancy into libc is unsafe), sandboxed/statically-linked minimal binaries, or when you're deliberately probing syscall behavior that libc abstracts away (e.g. `clone()`'s raw flags versus `pthread_create()`'s curated subset).

## 3. Memory: Two worlds sharing one address space

This is the part that surprises people who've only thought of "kernel space" as a separate machine: on a typical Linux/x86-64 process, the kernel's virtual address range is mapped into _every process's own page tables_, at the high end of the 48-bit (or 57-bit with 5-level paging) canonical address space. A classic split looks like:

```
0x0000000000000000 - 0x00007fffffffffff   user space (per-process)
0xffff800000000000 - 0xffffffffffffffff   kernel space (shared, same in every process)
```

The kernel doesn't get its own address space because switching `CR3` (the page table base) is itself expensive — a full TLB flush historically, or a PCID-tagged partial flush on newer CPUs. Mapping kernel memory into the top of every process's page tables means a syscall entry doesn't need a `CR3` switch at all; it just changes privilege ring while the _virtual address space itself_ stays the same.

Those kernel pages are mapped, but marked with the **supervisor** bit in the page table entry — so ring-3 code that tries to read or write them takes a page fault, even though the address is technically "there." This is what makes a wild pointer dereference from your C program safe(ish) with respect to the kernel: dereferencing a pointer that lands in kernel address space just faults, it doesn't succeed and corrupt kernel memory.

### The Meltdown wrinkle

This shared-mapping design is exactly what the Meltdown vulnerability (2018) exploited: speculative execution could read kernel-mapped pages before the permission check retired, leaking data through a cache side channel. The mitigation, KPTI (Kernel Page Table Isolation), largely undoes the "share one address space" optimization — it maintains mostly-separate page tables for user and kernel mode and switches between them on syscall entry/exit, which is precisely why KPTI has a measurable syscall-latency cost that shows up in benchmarks of syscall-heavy workloads.

### Why the kernel can't just deref your pointer either

The reverse direction has its own rule. When you call `read(fd, buf, count)`, the kernel receives `buf` as a user-space virtual address. It cannot simply dereference it — that address is only valid under _your_ process's page tables and permissions, and a malicious or buggy syscall argument could point at unmapped memory, or (in principle) try to trick the kernel into touching something it shouldn't. So every data transfer across the boundary goes through explicit, checked helpers: `copy_from_user()` and `copy_to_user()` inside the kernel, which validate the range against the process's address space and handle the possibility of a page fault mid-copy (the classic case being a `buf` that's technically mapped but not yet resident, triggering a fault the kernel must handle gracefully rather than crash on).

This is also why `write(fd, ptr, len)` with a `ptr` you got from `mmap(MAP_ANONYMOUS)` works fine, but passing a `ptr` that resolves to kernel address space (which you can't construct from user space anyway, since your virtual address range doesn't include it) isn't a coherent request at all — the kernel would just see it as out of range for `copy_from_user`.

## 4. Context switches and what they actually cost you

It's worth separating three distinct things people often lump together as "kernel overhead":

**A syscall (mode switch)** — ring 3 → ring 0 → ring 3, same process, same page tables (modulo KPTI). Cheapest of the three. Register save/restore plus whatever work the syscall handler does.

**A context switch within the same address space** — e.g. switching between two threads of the same process. No `CR3` reload needed (same page tables), but full register state save/restore, and the scheduler does its bookkeeping.

**A context switch across processes** — full register save/restore _plus_ a `CR3` reload, which (absent PCID) flushes the TLB. Every subsequent memory access has to re-walk page tables until the TLB warms back up. This is the expensive one, and it's why thread-heavy designs within one process are generally cheaper than process-heavy designs, independent of the fork/exec cost itself.

Concretely, a syscall that does almost nothing is a reasonable way to feel the fixed mode-switch cost:

```c
#include <unistd.h>
#include <time.h>
#include <stdio.h>

int main(void) {
    struct timespec t0, t1;
    const long N = 10 * 1000 * 1000;

    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (long i = 0; i < N; i++) {
        getpid();  // trivial syscall, does real work in the kernel
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);

    double secs = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    printf("%.1f ns/syscall\n", secs * 1e9 / N);
    return 0;
}
```

On a typical modern x86-64 machine with KPTI enabled you'll usually see somewhere in the tens-of-nanoseconds range per call — not free, and very much dependent on mitigations being on or off, but far cheaper than a cross-process context switch, which commonly runs into the low microseconds once you include scheduler latency.

## 5. The vDSO: Kernel code that runs in user space

Some "syscalls" don't need to cross the ring boundary at all, because the data they return doesn't require privileged access — it just requires code the kernel maintains and updates. The **vDSO** (virtual dynamic shared object) is a small shared library the kernel maps into every process's address space at exec time, containing implementations of a handful of hot syscalls, most notably `clock_gettime`, `gettimeofday`, and `getcpu`.

```c
#include <time.h>
struct timespec ts;
clock_gettime(CLOCK_MONOTONIC, &ts);  // usually resolved entirely in user space via the vDSO
```

Under the hood, glibc's `clock_gettime` doesn't necessarily issue `syscall`/`svc` at all — it calls into the vDSO-mapped function, which reads a kernel-updated shared memory region (containing the current time base and TSC/counter calibration) and computes the timestamp entirely in ring 3. No mode switch, no `sys_call_table` dispatch — just a function call and some arithmetic. You can watch this directly:

```bash
$ ltrace -e clock_gettime ./a.out   # shows the libc call
$ strace ./a.out                    # notice clock_gettime often doesn't appear at all
```

The vDSO is a nice concrete example that "kernel space" and "user space" isn't purely about _where the code physically lives_ — it's about _what privilege level it runs at_. vDSO code is kernel-authored and kernel-mapped, but it executes at ring 3.

## 6. Where your C/C++ code actually touches this boundary

Most of the time this boundary is invisible — you call `read()`, it works. But it surfaces in specific, practical ways:

**`EINTR` and signals.** A blocking syscall can be interrupted by a signal before completing. Historically this meant every blocking syscall call site needed an `EINTR` retry loop:

```c
ssize_t read_full_retry(int fd, void *buf, size_t count) {
    ssize_t n;
    do {
        n = read(fd, buf, count);
    } while (n < 0 && errno == EINTR);
    return n;
}
```

Since Linux 2.6/glibc, `SA_RESTART` (set via `sigaction`) makes many syscalls auto-restart after most signal handlers return, but not all of them (`select`, `poll`, and a few others are explicitly exempt even with `SA_RESTART`), so writing defensive retry loops around blocking I/O is still common, correct practice in serious systems code.

**Blocking vs. non-blocking, and the multiplexing evolution.** `select()` → `poll()` → `epoll()` → `io_uring` is largely a story about reducing how often, and how expensively, you cross into kernel space to ask "is anything ready yet." `select`/`poll` require passing the full fd set on every call and the kernel re-scanning it; `epoll` keeps kernel-side interest state across calls so each `epoll_wait` is cheap; `io_uring` goes further and lets user space and kernel space share ring buffers in mapped memory, so a well-designed submission/completion loop can batch many I/O operations per actual mode transition, or in some completion-polling configurations, avoid syscalls almost entirely on the hot path.

**Memory-mapped I/O and shared memory.** `mmap()` on a file, or `/dev/shm`-backed shared memory, moves data movement out of the read/write syscall path entirely — the kernel sets up page table mappings once, and afterward your loads/stores are ordinary memory accesses handled by the page fault mechanism (demand paging) rather than explicit syscalls per transfer.

**Kernel bypass proper: `eBPF`.** Rather than writing a kernel module, modern Linux lets you load small, verified programs (written in a restricted C subset, compiled to eBPF bytecode) that the kernel JITs and runs _inside_ kernel space, attached to hook points (syscall entry, network packet receipt, tracepoints). This is a genuinely different model from anything above: your logic executes at ring 0, but you never write raw kernel-module C, and a verifier statically rejects programs that could loop unboundedly or access memory unsafely, which is why it's considered safe enough to let unprivileged (or semi-privileged) programs load into the kernel at all.

**Writing an actual kernel module, briefly, for contrast.** If you do step into kernel space yourself — say, a minimal character device — the ground rules change completely from anything in user-space C:

```c
// Sketch only — omits module_init/exit, licensing boilerplate, etc.
static ssize_t mydev_read(struct file *f, char __user *buf,
                          size_t len, loff_t *off) {
    // Can't just memcpy into buf — it's a user pointer.
    if (copy_to_user(buf, kernel_msg, msg_len))
        return -EFAULT;
    return msg_len;
}
```

No libc. No `malloc` (use `kmalloc`/`kzalloc` instead, with explicit GFP flags governing whether the allocation may sleep). No page faults are allowed in certain contexts (interrupt handlers, with spinlocks held) — touching unmapped memory there is a kernel oops, not a recoverable `SIGSEGV`. Error handling is negative-`errno` return values throughout, not `errno` + `-1`. It's a genuinely different programming environment, which is precisely why most "kernel bypass" work today reaches for eBPF or `io_uring` instead of writing a full module.

## 7. Comparison table

| Aspect                               | User Space                                             | Kernel Space                                                                         |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| CPU privilege                        | Ring 3 (x86-64) / EL0 (ARM64)                          | Ring 0 (x86-64) / EL1 (ARM64)                                                        |
| Address space                        | Per-process, isolated by page tables                   | Shared across all processes (mapped into each, protection-bit gated)                 |
| Direct hardware access               | Not allowed (traps to fault)                           | Full access (I/O ports, MSRs, page tables, interrupts)                               |
| Memory allocator                     | `malloc`/`new` (glibc arenas, ultimately `brk`/`mmap`) | `kmalloc`/`vmalloc`/slab allocators, GFP-flag governed                               |
| Crash blast radius                   | Confined to the process (SIGSEGV, killed)              | Can be a full kernel oops/panic — whole machine at risk                              |
| Standard library                     | Full libc/libstdc++ available                          | No libc; restricted kernel APIs only                                                 |
| Typical debugging tools              | gdb, valgrind, ASan/UBSan, perf (userspace events)     | kgdb, ftrace, kprobes/eBPF tracing, `/proc/kmsg`, crash dumps                        |
| Entry from the other side            | Syscalls, `int`/`svc` traps, page faults               | Signal delivery, return from syscall, scheduler preemption back to user              |
| Can block indefinitely on user error | Yes, freely                                            | Strongly discouraged/disallowed in many contexts (interrupt handlers must not sleep) |
| Pointer safety across the boundary   | N/A (own memory)                                       | Must use `copy_from_user`/`copy_to_user`; never deref raw user pointers              |

## 8. Decision framework: Do you actually need kernel space?

For the overwhelming majority of systems programming on Linux, the honest answer is no — and the ecosystem has spent the last decade building faster on-ramps precisely so you don't have to:

- **Need high-throughput async I/O?** Reach for `io_uring` before writing a kernel module. You get shared ring buffers and batched syscalls without leaving user space.
- **Need to observe or lightly intervene in kernel behavior** (tracing, simple packet filtering/redirection, syscall auditing)? `eBPF` gets your logic running at ring 0 with the kernel's own verifier guaranteeing safety, without you writing or maintaining out-of-tree kernel module code.
- **Need low-latency IPC or zero-copy data sharing** between processes? `mmap`/`shm`/`io_uring`'s shared-memory model, not a custom driver.
- **Actually need kernel space:** you're implementing a new filesystem, a new scheduling class, a device driver for hardware with no existing driver, or something that genuinely requires running before user space even exists (early boot, low-level hardware initialization) — cases where there's no user-space API for what you need because the kernel hasn't been asked to expose one.

The pattern across the last ~15 years of Linux kernel development — `epoll` → `io_uring`, ad-hoc tracing → `eBPF`, `netfilter` modules → `XDP`/eBPF-based networking — is a consistent move toward giving user-space programs kernel-level performance and kernel-level hooks _without_ the safety and maintenance burden of writing privileged code yourself. As a C/C++ developer, understanding where the ring-3/ring-0 boundary actually is, and what it costs to cross, is what lets you tell whether a performance problem is even solvable in user space, or whether you've hit a wall that genuinely requires going lower.
