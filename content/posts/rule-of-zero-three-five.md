+++ 
draft = false
date = 2026-08-08T09:11:10+02:00
title = "The Rule of Zero, Three, and Five"
tags = ["C++", "RAII", "rule-of-zero", "rule-of-three", "rule-of-five"]
categories = ["C++"]
+++

## 1. Introduction

C++ classes have up to five **special member functions**: the destructor, the copy constructor, the copy assignment operator, the move constructor, and the move assignment operator. What makes them "special" is that the compiler can generate each of them for you automatically — but only under specific conditions, and declaring any one of them changes what the compiler is willing to generate for the others.

That interaction — one declaration silently changing the generation of the rest — is the source of most of the historical bugs this family of rules exists to prevent. If you've followed the earlier posts here on `noexcept` and move semantics, or on the copy-and-swap idiom with a `friend swap`, you've already seen pieces of this picture. This post assembles the full picture: what the compiler generates by default, when that default is wrong, and the three "rules" — Zero, Three, and Five — that summarize how to get it right.

## 2. Rule of Three

Before C++11, a class had three special member functions worth worrying about: the destructor, the copy constructor, and the copy assignment operator. The **Rule of Three** states: if you find yourself needing to explicitly define _any one_ of these three, you almost certainly need to define all three.

Here's the canonical failure case — a class managing a raw, manually-allocated resource:

```cpp
class Buffer {
    char* data_;
    std::size_t size_;
public:
    Buffer(std::size_t size) : data_(new char[size]), size_(size) {}
    ~Buffer() { delete[] data_; }   // user-defined destructor
    // no copy constructor, no copy assignment defined
};
```

The moment you write that destructor, the compiler-generated copy constructor and copy assignment operator become dangerous. They perform a **shallow copy** — copying the `data_` pointer itself, not the memory it points to:

```cpp
Buffer a(100);
Buffer b = a;     // shallow copy: b.data_ == a.data_
```

Now `a` and `b` both believe they own the same heap allocation. When either goes out of scope, its destructor runs `delete[] data_`. When the _second_ one goes out of scope, it deletes memory that's already been freed — a double free, undefined behavior, and one of the most common sources of hard-to-diagnose memory corruption in pre-C++11 codebases. The fix, per the Rule of Three, is to define all three together:

```cpp
class Buffer {
    char* data_;
    std::size_t size_;
public:
    Buffer(std::size_t size) : data_(new char[size]), size_(size) {}

    ~Buffer() { delete[] data_; }

    Buffer(const Buffer& other)
        : data_(new char[other.size_]), size_(other.size_) {
        std::copy(other.data_, other.data_ + size_, data_);
    }

    Buffer& operator=(const Buffer& other) {
        if (this != &other) {
            char* new_data = new char[other.size_];
            std::copy(other.data_, other.data_ + other.size_, new_data);
            delete[] data_;
            data_ = new_data;
            size_ = other.size_;
        }
        return *this;
    }
};
```

Now copying performs a real deep copy, and each `Buffer` genuinely owns its own allocation.

## 3. Rule of Five

C++11 added move semantics, and with them, two more special member functions: the move constructor and the move assignment operator. The **Rule of Five** extends the Rule of Three: if you need to define any of the destructor, copy constructor, or copy assignment operator, you likely need to define — or at least explicitly consider — all five.

The reason this matters isn't just consistency. It's that **defining a destructor, copy constructor, or copy assignment operator suppresses implicit generation of the move operations entirely.** Without move operations, every place your `Buffer` would have moved — return by value, insertion into a `std::vector`, passing an rvalue — instead falls back to the copy constructor, because the copy constructor is a viable match even when a move would have been possible. Your class compiles fine and runs correctly, but silently pays for a full deep copy — including a heap allocation — everywhere a move should have been a cheap pointer swap.

```cpp
class Buffer {
    char* data_;
    std::size_t size_;
public:
    // ... constructor, destructor, copy ctor, copy assignment as above ...

    Buffer(Buffer&& other) noexcept
        : data_(other.data_), size_(other.size_) {
        other.data_ = nullptr;
        other.size_ = 0;
    }

    Buffer& operator=(Buffer&& other) noexcept {
        if (this != &other) {
            delete[] data_;
            data_ = other.data_;
            size_ = other.size_;
            other.data_ = nullptr;
            other.size_ = 0;
        }
        return *this;
    }
};
```

Marking these `noexcept` matters beyond documentation — as covered in the earlier post on `noexcept` and `std::vector` reallocation, containers like `std::vector` only use the move constructor during reallocation if it's marked `noexcept`; otherwise, for exception-safety reasons, they fall back to copying even when a perfectly good move constructor exists.

## 4. The Generation Matrix: Who Disables Whom

This is the part most people get wrong from memory, because the actual rule isn't symmetric and isn't the same for every pair. The precise behavior:

- Declaring the **destructor** doesn't remove copy operations, but it does mark them **deprecated** (they're still implicitly generated, but the standard has deprecated relying on this since C++11 — a future standard could remove it). It **suppresses** implicit generation of both move operations entirely — they simply won't exist.
- Declaring **either copy operation** (copy constructor or copy assignment) suppresses implicit generation of **both move operations**. The destructor and the other copy operation are unaffected — still implicitly generated normally.
- Declaring **either move operation** (move constructor or move assignment) causes both copy operations to be implicitly **defined as deleted** — not merely suppressed, but present and explicitly unusable, which is a stronger statement (more on this distinction in the next section). It also suppresses implicit generation of the _other_ move operation. The destructor is unaffected.

| User declares ↓ | Destructor         | Copy ctor               | Copy assign             | Move ctor         | Move assign       |
| --------------- | ------------------ | ----------------------- | ----------------------- | ----------------- | ----------------- |
| **Destructor**  | —                  | generated, _deprecated_ | generated, _deprecated_ | **not generated** | **not generated** |
| **Copy ctor**   | generated normally | —                       | generated normally      | **not generated** | **not generated** |
| **Copy assign** | generated normally | generated normally      | —                       | **not generated** | **not generated** |
| **Move ctor**   | generated normally | **defined as deleted**  | **defined as deleted**  | —                 | **not generated** |
| **Move assign** | generated normally | **defined as deleted**  | **defined as deleted**  | **not generated** | —                 |

Read a row as "if the user declares this function, here's what happens to each of the other four." Two distinct outcomes are easy to conflate: **"not generated"** means the function simply doesn't exist — overload resolution behaves as if it were never a candidate, and if nothing else applies, this typically means a copy is used instead (for the missing move case) or the class becomes non-copyable/non-movable outright (if copies are also unavailable). **"Defined as deleted"** is different and stronger: the function _does_ exist, as an implicitly-declared function marked `= delete`, meaning any attempt to use it is a hard compile error naming that specific deleted function — and, as covered below, this also changes what type traits like `std::is_copy_constructible` report.

The practical consequence of this table: define a move constructor on a class, forget to also define copy operations, and that class becomes silently non-copyable — every copy attempt is a compile error pointing at an implicitly-deleted function, which can be a confusing message if you don't know this table exists.

## 5. `= default` and `= delete`, Explicitly

Given how easy it is to trigger unintended suppression, C++11 gave you a way to state your intent directly instead of relying on implicit generation rules.

### 5.1 `= default`

`= default` tells the compiler "generate the version you would have generated anyway" — but write it explicitly:

```cpp
class Widget {
public:
    ~Widget() { /* custom logging on destruction */ }

    Widget(const Widget&) = default;
    Widget& operator=(const Widget&) = default;
    Widget(Widget&&) = default;
    Widget& operator=(Widget&&) = default;
};
```

Without those four `= default` lines, the user-defined destructor here would suppress both move operations (Section 4), silently degrading every move of a `Widget` into a copy. Writing `= default` explicitly restores them — and, just as importantly, **documents the decision**. A reader six months from now sees exactly what's intended, instead of having to recall or re-derive the generation matrix from Section 4 to understand why moves are or aren't available.

`= default` can also be used to pin down behavior that would otherwise depend on implementation-defined generation timing — for instance, defaulting a member function in the class body vs. out-of-line in a `.cpp` file changes whether the class is considered "trivial" for certain type-trait purposes, which matters for ABI-sensitive code.

**`= default` does not, by itself, mean `noexcept`.** Writing `Widget(Widget&&) = default;` without an explicit exception specification doesn't make the resulting function `noexcept` just because you asked for it — the compiler _computes_ the exception specification the same way it would for an implicitly-declared special member function: it inspects the corresponding operation (move constructor, or move assignment for the assignment operator) of every base class subobject and every non-static data member, and the defaulted function is `noexcept` if and only if all of them are. If even one member's move constructor isn't `noexcept` — a hand-rolled type that forgot to mark it, or a type where it genuinely can throw — the defaulted `Widget(Widget&&)` silently becomes potentially-throwing too, with no warning from the compiler pointing this out.

This matters concretely: as covered in the earlier post on `noexcept` and `std::vector` reallocation, `std::vector<Widget>` decides whether to move or copy during reallocation based on `std::is_nothrow_move_constructible_v<Widget>` — which reflects exactly this computed specification, not the mere presence of `= default` in the source. A `= default`-ed move constructor that looks perfectly fine can still cost you silent copies at reallocation time if one member's move isn't `noexcept`.

There's a sharper trap if you try to force the issue by writing `noexcept` explicitly alongside `= default`:

```cpp
Widget(Widget&&) noexcept = default;
```

If the implicitly-computed specification would have been `noexcept(false)` — because some member's move constructor can throw — this doesn't produce a compile error. Instead, the function is **defined as deleted**. `Widget` silently loses its move constructor entirely, falling back to copy wherever a move was expected, which is often a harder bug to notice than a straightforward compiler error would have been. The safe approach is to let `= default` compute the specification implicitly and, if you need to guarantee `noexcept`, verify it deliberately — e.g., with a `static_assert(std::is_nothrow_move_constructible_v<Widget>)` right after the class definition, which fails loudly and specifically instead of quietly deleting the function.

### 5.2 `= delete`

`= delete` explicitly removes a function from overload resolution, making any use of it a compile error — with a clear diagnostic naming exactly what was deleted, rather than a confusing implicit-deletion message:

```cpp
class FileHandle {
    int fd_;
public:
    explicit FileHandle(int fd) : fd_(fd) {}
    ~FileHandle() { close(fd_); }

    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;

    FileHandle(FileHandle&&) noexcept = default;
    FileHandle& operator=(FileHandle&&) noexcept = default;
};
```

This is the standard idiom for **move-only, non-copyable resource wrappers** — the same category `std::unique_ptr` and `std::mutex` belong to. Deleting copy operations while keeping move operations gives you exactly one, transferable owner of the underlying resource, with the compiler enforcing it rather than a comment.

### 5.3 Not-declared vs. deleted: why it matters for type traits

This distinction from Section 4 has a concrete, checkable effect: `std::is_copy_constructible_v<T>` and similar traits use SFINAE internally (see the earlier post on SFINAE for the mechanism) to check whether the relevant function is _usable_ — and a function defined as deleted is visible to name lookup and overload resolution, just unusable, which trips these traits the same way a normal, callable function would pass them. A function that was never declared at all behaves identically from the trait's point of view — either way, `is_copy_constructible_v` correctly reports `false`. The practical difference shows up at the call site: attempting to copy a type with a deleted copy constructor gives a clear "use of deleted function" diagnostic pointing at the exact declaration; a type that never had one implicitly generated, with no fallback, produces a message about no matching constructor instead. Explicitly writing `= delete` is almost always the more diagnosable choice, which is a good reason to prefer it over relying on implicit suppression even when the end result — non-copyability — is the same.

## 6. Rule of Zero

The Rule of Three and Rule of Five are correct, but they're also a lot of hand-written, error-prone boilerplate — a class with a raw resource needs somewhere between three and five carefully-written functions, each a fresh opportunity for a subtle bug. The modern default, the **Rule of Zero**, sidesteps the problem entirely: **design classes so they never need to define any of the five special member functions at all**, by delegating all resource ownership to types that already manage it correctly — `std::unique_ptr`, `std::shared_ptr`, `std::vector`, `std::string`, and similar RAII types.

Rewriting `Buffer` from Section 2–3 under the Rule of Zero:

```cpp
class Buffer {
    std::vector<char> data_;
public:
    explicit Buffer(std::size_t size) : data_(size) {}
    // that's it. No destructor, no copy/move operations written by hand.
};
```

`std::vector<char>` already correctly implements the Rule of Five internally. `Buffer`'s compiler-generated destructor, copy operations, and move operations each simply invoke `std::vector`'s corresponding operation on `data_` — deep copy on copy, cheap pointer transfer on move, correct cleanup on destruction — for free, with zero hand-written resource-management code and zero opportunity to get any of it wrong.

This is why the standard advice for modern C++ is: **reach for `unique_ptr`, `shared_ptr`, `vector`, and `string` as members instead of raw owning pointers**, precisely so the class containing them can stay in Rule-of-Zero territory and never need Section 4's generation matrix at all.

## 7. When Rule of Zero Isn't Enough

Rule of Zero covers the overwhelming majority of everyday classes, but a few scenarios genuinely need custom special member functions:

**Polymorphic deep copying.** A class holding a `std::vector<std::unique_ptr<Base>>` needs a custom copy constructor and copy assignment that deep-copy each polymorphic element correctly — `vector`'s own copy constructor can't do this for you, since `unique_ptr` is move-only and copying it isn't even well-formed. This is exactly the scenario the earlier post on the virtual constructor idiom addresses via `clone()` — a custom copy constructor here typically just calls `clone()` on each element rather than reimplementing deep-copy logic from scratch:

```cpp
class Document {
    std::vector<std::unique_ptr<Shape>> shapes_;
public:
    Document() = default;

    // Rule of Zero fails here: the compiler can't generate a copy
    // constructor for vector<unique_ptr<Shape>> at all — it's deleted,
    // because unique_ptr itself isn't copyable.
    Document(const Document& other) {
        shapes_.reserve(other.shapes_.size());
        for (const auto& s : other.shapes_) {
            shapes_.push_back(s->clone());   // relies on the virtual constructor idiom
        }
    }

    Document& operator=(const Document& other) {
        Document tmp(other);
        std::swap(shapes_, tmp.shapes_);
        return *this;
    }

    // Move operations can still be defaulted — moving a vector of
    // unique_ptr is unproblematic, it's only copying that's the issue.
    Document(Document&&) = default;
    Document& operator=(Document&&) = default;
    ~Document() = default;
};
```

Note the asymmetry: only the copy operations need hand-written logic. Move construction and move assignment work fine on `vector<unique_ptr<Base>>` without any help, since moving doesn't require knowing the concrete type — it just transfers ownership of the pointers wholesale. This is a common, correct pattern: mix Rule-of-Zero-style defaulted move operations with explicitly hand-written copy operations, rather than writing all five by hand once any one needs custom logic.

**Non-owning resources with manual lifetime semantics.** Wrapping a C API handle, a non-owning observer pointer with specific invalidation rules, or any resource where "copy" and "move" need domain-specific meaning beyond what any standard RAII type expresses — these need hand-written special member functions because no existing type captures the right semantics. A common concrete case: a lightweight view or handle that _references_ a resource owned elsewhere, without participating in its lifetime at all:

```cpp
class DatabaseCursor {
    sqlite3_stmt* stmt_;   // non-owning: the connection object owns the underlying statement
    bool at_end_ = false;
public:
    explicit DatabaseCursor(sqlite3_stmt* stmt) : stmt_(stmt) {}

    // No destructor needed at all — this class doesn't own stmt_,
    // so there's nothing to release. Rule of Zero would suggest omitting
    // it entirely, but copy/move still need to be constrained deliberately,
    // which is why this doesn't qualify as a clean Rule-of-Zero class.

    // Copying a cursor doesn't mean "duplicate the underlying statement" —
    // sqlite3_stmt* isn't cheaply duplicable, and two cursors silently
    // sharing one stmt_ while independently calling sqlite3_step() would
    // corrupt iteration state. So copying is explicitly forbidden:
    DatabaseCursor(const DatabaseCursor&) = delete;
    DatabaseCursor& operator=(const DatabaseCursor&) = delete;

    // Moving is fine — it's just transferring which statement this
    // particular cursor object refers to, with no cleanup implied.
    DatabaseCursor(DatabaseCursor&&) noexcept = default;
    DatabaseCursor& operator=(DatabaseCursor&&) noexcept = default;

    bool next() { /* calls sqlite3_step(stmt_), updates at_end_ */ return !at_end_; }
};
```

The interesting design decision here isn't in any function body — it's in what's `= delete`d versus `= default`ed. A plain observer pointer member (`sqlite3_stmt*`) would, under implicit generation rules, make this class trivially copyable, and that's exactly the wrong default: a bitwise copy of `stmt_` produces two `DatabaseCursor` objects both able to call `sqlite3_step()` on the same underlying statement, corrupting shared iteration state neither cursor knows about. Deleting copy operations explicitly — rather than relying on Rule of Zero to happen to produce safe behavior — is the whole point: this class's correctness depends on the compiler _refusing_ to generate the operations it normally would, not on it generating the right ones automatically.

A related but distinct case is a raw non-owning pointer with a documented invalidation contract — e.g., a `Widget*` cached inside another object purely as "the widget most recently focused," where the pointer is understood to potentially dangle if that widget is destroyed elsewhere, and copying the cache is meaningful and safe (copying just duplicates the observation, not any ownership). There, defaulting copy and move is correct, and the only custom work needed is documentation of the invalidation contract — nothing in the special member functions themselves needs to change, which is a useful contrast: not every raw pointer member forces you out of Rule of Zero, only the ones where copying or moving needs to _do_ something beyond a bitwise copy, or needs to be _forbidden_ outright.

**Custom reference counting or shared-ownership schemes** that don't map cleanly onto `std::shared_ptr`'s semantics — for instance, intrusive reference counting where the count lives inside the object itself rather than in a separate control block. This is a common pattern in codebases interfacing with COM, plugin systems, or performance-sensitive code that wants to avoid `shared_ptr`'s separate control-block allocation:

```cpp
class RefCounted {
    mutable std::atomic<int> refcount_{0};
protected:
    virtual ~RefCounted() = default;   // protected: only release() destroys
public:
    void add_ref() const noexcept { refcount_.fetch_add(1, std::memory_order_relaxed); }
    void release() const noexcept {
        if (refcount_.fetch_sub(1, std::memory_order_acq_rel) == 1) {
            delete this;
        }
    }
};

template <typename T>
class IntrusivePtr {
    T* ptr_ = nullptr;
public:
    IntrusivePtr() = default;

    explicit IntrusivePtr(T* p) : ptr_(p) {
        if (ptr_) ptr_->add_ref();
    }

    IntrusivePtr(const IntrusivePtr& other) : ptr_(other.ptr_) {
        if (ptr_) ptr_->add_ref();     // copy = share ownership, bump the count
    }

    IntrusivePtr& operator=(const IntrusivePtr& other) {
        if (this != &other) {
            if (ptr_) ptr_->release();
            ptr_ = other.ptr_;
            if (ptr_) ptr_->add_ref();
        }
        return *this;
    }

    IntrusivePtr(IntrusivePtr&& other) noexcept : ptr_(other.ptr_) {
        other.ptr_ = nullptr;          // move = transfer, no refcount change needed
    }

    IntrusivePtr& operator=(IntrusivePtr&& other) noexcept {
        if (this != &other) {
            if (ptr_) ptr_->release();
            ptr_ = other.ptr_;
            other.ptr_ = nullptr;
        }
        return *this;
    }

    ~IntrusivePtr() { if (ptr_) ptr_->release(); }
};
```

Here all five special member functions carry genuine, non-boilerplate logic: copy means "share ownership, increment the count," move means "transfer ownership, no count change," and the destructor means "decrement, and destroy on the last release." No standard-library RAII type expresses this exact intrusive-refcounting semantics, so `IntrusivePtr` sits firmly outside Rule of Zero territory — this is precisely the kind of class where writing out the full Rule of Five by hand, carefully, is the correct and necessary choice rather than something to avoid.

**Logging, instrumentation, or invariant-checking on construction/destruction/copy** — sometimes you genuinely want a custom destructor purely for a side effect (a scoped logger, a profiling scope guard), in which case Section 5's `= default` for the remaining four becomes the relevant tool, not a full Rule-of-Five rewrite.

In every one of these cases, the goal is still to write the _minimum_ necessary custom code and delegate everything else — mixing hand-written and defaulted special member functions, as in the `FileHandle` and `Widget` examples above, rather than reverting to writing all five by hand once any one of them needs custom logic.

## 8. Summary

Five special member functions govern how a C++ object is destroyed, copied, and moved, and the compiler's willingness to generate any one of them depends on which of the others you've declared — a set of interactions precise enough to deserve the matrix in Section 4, not just an approximate mental model. The Rule of Three (pre-C++11: destructor, copy constructor, copy assignment travel together) and the Rule of Five (C++11 onward: add move constructor and move assignment to that group) describe when hand-written resource management forces you to define these functions explicitly and consistently. `= default` and `= delete` let you state your intent for any of the five directly, rather than relying on — and hoping you correctly recall — the implicit generation rules. But the real modern default is the Rule of Zero: design classes to hold RAII members like `unique_ptr`, `shared_ptr`, `vector`, and `string`, so that none of these five functions need to be written by hand at all, and reserve custom special member functions for the genuinely exceptional cases — polymorphic deep copy, non-owning handles, custom reference counting — where no existing type already expresses the semantics you need.
