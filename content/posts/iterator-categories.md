+++ 
draft = false
date = 2026-08-12T08:27:58+02:00
title = "Iterator categories in C++: A complete reference"
tags = ["C++", "iterators", "STL", "templates", "tag-dispatch", "concepts"]
categories = ["C++"]
+++

## 1. Introduction

An iterator is C++'s generalization of a pointer: something that can be dereferenced to access a value and advanced to move to the next one, without the code using it needing to know what kind of container it's actually walking over. That generalization is what makes the STL's algorithm/container split possible — `std::sort`, `std::find`, `std::accumulate` are written once, against an iterator interface, and work identically over a `std::vector`, a `std::deque`, or a raw array, because none of them ever touch the container directly.

But not every container can support the same set of operations efficiently. A `std::vector` can jump to any element in O(1) via pointer arithmetic; a `std::forward_list` can only walk forward, one node at a time; an `std::istream_iterator` reading from a stream can't even be dereferenced twice at the same position, because reading consumes the stream. If the STL exposed one universal iterator interface, it would have to either restrict every algorithm to the weakest container's capabilities, or silently offer operations that are unsafe or wrong for some containers.

The solution is **iterator categories**: a hierarchy of interfaces, each one a strict superset of requirements over the one before it, letting algorithms declare exactly what they need and containers declare exactly what they can provide. This post works through all six categories in order, from weakest to strongest.

## 2. The Category Hierarchy

Six categories, traditionally identified (pre-C++20) by empty "tag" structs in `<iterator>`:

```
Input Iterator ──┐
                  ├──► Forward Iterator ──► Bidirectional Iterator ──► Random Access Iterator ──► Contiguous Iterator
Output Iterator ──┘
```

Input and Output are the two most primitive categories, sitting at the base — one for reading, one for writing, largely independent of each other. Forward Iterator builds on Input Iterator's interface by adding the guarantee of repeatable traversal. Each subsequent category is a strict refinement: everything a Forward Iterator can do, a Bidirectional Iterator can also do, plus `operator--`; everything a Bidirectional Iterator can do, a Random Access Iterator can also do, plus arithmetic; everything a Random Access Iterator can do, a Contiguous Iterator can also do, plus a memory-layout guarantee.

This cumulative structure is exactly why an algorithm requiring, say, a Forward Iterator will happily accept a `std::vector::iterator` (which is Contiguous, and therefore also everything below it) but will reject a `std::istream_iterator` (which is only Input).

## 3. Input Iterator

The **Input Iterator** is the weakest category: single-pass, read-only traversal. "Single-pass" is the critical, easy-to-miss constraint — as covered in more depth in the earlier post on the semantic role of `++` in single-pass iterators, once you increment an Input Iterator, any copies of its old position are no longer guaranteed to be valid or comparable. You get exactly one look at each element, in order, moving forward, and that's it.

Required operations: `*it` (read-only dereference), `++it` and `it++` (advance), `it == it2` / `it != it2` (equality comparison, primarily used to test against an end sentinel).

```cpp
std::istream_iterator<int> in(std::cin);
std::istream_iterator<int> end;

while (in != end) {
    std::cout << *in << "\n";
    ++in;   // reading a value consumes it — you can't re-read the same position
}
```

`std::istream_iterator` is the textbook Input Iterator: reading from `std::cin` is inherently single-pass, since the underlying stream has no way to "rewind" to a previously-read position.

## 4. Output Iterator

The **Output Iterator** is Input's mirror image: single-pass, write-only. Instead of `*it` producing a value, `*it = value` consumes one.

Required operations: `*it = value` (write), `++it` and `it++` (advance). Notably, Output Iterators are _not_ required to support comparison against an end sentinel at all — writing is often open-ended, with the calling code responsible for knowing when to stop.

```cpp
std::vector<int> source{1, 2, 3, 4, 5};
std::ostream_iterator<int> out(std::cout, ", ");
std::copy(source.begin(), source.end(), out);
```

`std::back_insert_iterator` (produced by `std::back_inserter`) is the other common Output Iterator: `*it = value` translates into a `push_back(value)` call on the underlying container, letting algorithms like `std::copy` or `std::transform` append to a container they never explicitly resize or index into.

## 5. Forward Iterator

A **Forward Iterator** upgrades Input Iterator with the single guarantee that matters most for algorithm design: **multi-pass**. You can copy a Forward Iterator, advance the copy, and the original still points to the same valid position it did before — meaning you can traverse the same range more than once, or hold onto a position while continuing to advance a different iterator over the same range.

```cpp
template <typename ForwardIt>
bool has_duplicate_adjacent(ForwardIt first, ForwardIt last) {
    if (first == last) return false;
    ForwardIt prev = first;
    ++first;
    while (first != last) {
        if (*prev == *first) return true;
        ++prev;    // prev and first both independently walk the same range
        ++first;
    }
    return false;
}
```

This function is impossible to write correctly against a plain Input Iterator — `prev` and `first` need to independently reference two different, still-valid positions in the same range simultaneously, which Input Iterator's single-pass guarantee explicitly doesn't promise. Forward Iterator also requires default-constructibility (so a default-constructed iterator can serve as a well-defined placeholder), which Input Iterator doesn't require either.

`std::forward_list::iterator` is the category's namesake example: a singly-linked list supports forward-only traversal, but — unlike a stream — it supports it repeatably, since the nodes themselves persist.

## 6. Bidirectional Iterator

A **Bidirectional Iterator** adds exactly one capability over Forward: `operator--`, moving backward one position.

```cpp
template <typename BidirIt>
void print_reversed(BidirIt first, BidirIt last) {
    while (last != first) {
        --last;
        std::cout << *last << " ";
    }
}
```

This requires the underlying data structure to support efficient backward traversal, which rules out singly-linked structures like `std::forward_list` but is straightforward for doubly-linked ones. `std::list::iterator` (a doubly-linked list, where each node has both `next` and `prev` pointers) and `std::map`/`std::set::iterator` (typically implemented as a red-black tree, where moving to the in-order predecessor is a well-defined, boundedly-efficient tree operation) are the standard examples.

## 7. Random Access Iterator

A **Random Access Iterator** is where iterators start behaving like raw pointer arithmetic: constant-time jumps to _any_ position, not just the adjacent one.

Added operations: `it + n` / `it - n` (offset by n), `it += n` / `it -= n`, `it1 - it2` (distance between two iterators), `it[n]` (subscript), and full ordering comparisons `<`, `<=`, `>`, `>=` (not just `==`/`!=`).

```cpp
template <typename RandomIt>
void quick_partition_demo(RandomIt first, RandomIt last) {
    auto mid = first + (last - first) / 2;   // O(1) jump to the midpoint
    std::iter_swap(first, mid);
}
```

This O(1) midpoint computation is exactly why algorithms like binary search or a from-scratch quicksort partition need Random Access specifically — walking to the midpoint one `++` at a time would silently degrade an O(log n) algorithm's complexity if the iterator only offered Bidirectional's interface. `std::vector::iterator` and `std::deque::iterator` are the standard examples — `deque`'s chunked, non-contiguous storage still supports O(1) random access via a layer of indirection, which is why it qualifies for this category despite not being contiguous (see the next section for why that distinction matters).

## 8. Contiguous Iterator

**Contiguous Iterator**, added formally in C++17 (with `std::contiguous_iterator` as a proper concept in C++20), doesn't add any new _operations_ over Random Access — the interface is identical. What it adds is a **guarantee about memory layout**: the elements the iterator ranges over are laid out contiguously in memory, such that `&*(it + n) == &*it + n` for any valid offset `n`.

This might look like a technicality, but it has real consequences. Code that needs to interoperate with C APIs expecting a raw contiguous buffer — `memcpy`, POSIX `write()`, GPU buffer uploads — needs more than "I can compute distances and jump around in O(1)"; it needs an actual contiguous block of memory it can take the address of and pass across an API boundary. `std::deque::iterator` satisfies Random Access (O(1) indexed access) but _not_ Contiguous (a deque's storage is chunked — a series of separately-allocated fixed-size blocks — so no such raw-buffer guarantee holds), which is exactly the distinction this category exists to express.

`std::to_address(it)` (C++20) is the standard tool for safely obtaining the underlying raw pointer from a Contiguous Iterator without relying on `&*it`, which can misbehave for fancy pointer types (like the iterators of `std::vector<bool>`'s odd proxy-reference specialization, or custom allocator-aware pointer types). `std::array`, `std::vector` (except the `bool` specialization), and `std::string`/`std::string_view` all provide Contiguous Iterators.

## 9. Comparative Table

Each row shows the _additional_ requirement introduced at that category, on top of everything above it in the table:

| Category          | Read | Write  | `++`            | Multi-pass | `--` | `it+n`/`it[n]`/`<` (O(1)) | Contiguous memory |
| ----------------- | ---- | ------ | --------------- | ---------- | ---- | ------------------------- | ----------------- |
| **Input**         | ✓    | —      | ✓ (single-pass) | —          | —    | —                         | —                 |
| **Output**        | —    | ✓      | ✓ (single-pass) | —          | —    | —                         | —                 |
| **Forward**       | ✓    | (opt.) | ✓               | ✓          | —    | —                         | —                 |
| **Bidirectional** | ✓    | (opt.) | ✓               | ✓          | ✓    | —                         | —                 |
| **Random Access** | ✓    | (opt.) | ✓               | ✓          | ✓    | ✓                         | —                 |
| **Contiguous**    | ✓    | (opt.) | ✓               | ✓          | ✓    | ✓                         | ✓                 |

("(opt.)" — Forward and above may or may not be writable, independent of the category itself; a `std::vector<const int>`-style const iterator is Random Access/Contiguous but not writable, while a mutable `std::vector<int>::iterator` is both.)

Representative standard-library iterators per category:

| Category      | Example                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| Input         | `std::istream_iterator`                                                  |
| Output        | `std::ostream_iterator`, `std::back_insert_iterator`                     |
| Forward       | `std::forward_list::iterator`, `std::unordered_map::iterator`            |
| Bidirectional | `std::list::iterator`, `std::map::iterator`, `std::set::iterator`        |
| Random Access | `std::deque::iterator`                                                   |
| Contiguous    | `std::vector::iterator`, `std::array::iterator`, `std::string::iterator` |

## 10. C++20 Iterator Concepts

Historically, categories were identified through **tag types** — empty structs like `std::input_iterator_tag`, `std::forward_iterator_tag`, each derived from the previous, used purely as compile-time markers via a nested `iterator_category` typedef (or, since C++17, via `std::iterator_traits<It>::iterator_category`). C++20 reframes the same six categories as actual **concepts**: `std::input_iterator`, `std::forward_iterator`, `std::bidirectional_iterator`, `std::random_access_iterator`, `std::contiguous_iterator`.

The practical difference mirrors exactly what the earlier post on SFINAE and concepts covered in general: a tag-based check works through traits and overload resolution tricks, producing an opaque error when a type doesn't qualify, while a concept states the requirement directly and produces a targeted diagnostic naming exactly which operation is missing. Functionally, for existing standard containers, the two systems describe the same six categories — C++20 concepts didn't change what a Forward Iterator _is_, only how that requirement is expressed and checked.

```cpp
// Pre-C++20: tag dispatch on iterator_category
template <typename It>
void advance_impl(It& it, std::ptrdiff_t n, std::random_access_iterator_tag) {
    it += n;   // O(1)
}

// C++20: concept-constrained overload, same intent, direct requirement
template <std::random_access_iterator It>
void advance_fast(It& it, std::ptrdiff_t n) {
    it += n;
}
```

## 11. Tag Dispatch by Iterator Category

The categories aren't just documentation — they're routinely used to select genuinely different _implementations_ of the same algorithm at compile time, based on what an iterator can efficiently do. `std::advance` and `std::distance` are the canonical examples, and the technique is tag dispatch, covered in full in the earlier post on that idiom — here it's worth seeing tag dispatch applied specifically to iterator categories, since it's the pattern's most common real-world use in the standard library itself.

```cpp
template <typename It>
void my_advance(It& it, std::ptrdiff_t n, std::input_iterator_tag) {
    while (n > 0) { ++it; --n; }   // must step one at a time: O(n)
}

template <typename It>
void my_advance(It& it, std::ptrdiff_t n, std::bidirectional_iterator_tag) {
    if (n >= 0) while (n-- > 0) ++it;
    else        while (n++ < 0) --it;   // still O(n), but can go backward too
}

template <typename It>
void my_advance(It& it, std::ptrdiff_t n, std::random_access_iterator_tag) {
    it += n;   // O(1): the whole reason this overload exists
}

template <typename It>
void my_advance(It& it, std::ptrdiff_t n) {
    my_advance(it, n, typename std::iterator_traits<It>::iterator_category{});
}
```

Calling `my_advance` on a `std::list::iterator` silently walks the list one node at a time in O(n); calling it on a `std::vector::iterator` silently jumps in O(1) via `+=`. The caller writes identical code either way — `my_advance(it, 100)` — and the compiler picks the fastest available implementation for that specific iterator's actual capabilities, entirely at compile time, with zero runtime branching or cost for the dispatch itself.

## 12. Summary

Iterator categories exist because containers genuinely differ in what traversal operations they can support efficiently, and the STL's algorithm/container decoupling only works if algorithms can express exactly what they need rather than assuming a lowest common denominator. The six categories — Input, Output, Forward, Bidirectional, Random Access, and Contiguous — form a cumulative hierarchy, each adding one clear capability: repeatable traversal, backward movement, O(1) arithmetic, and finally a guarantee about actual memory layout. C++20 concepts reframe the same six categories with better diagnostics, without changing what they mean. And the categories aren't academic — `std::advance`, `std::distance`, and a great deal of STL-adjacent code use tag dispatch on exactly these categories to pick the fastest correct implementation available for whatever iterator they're handed, entirely at compile time.
