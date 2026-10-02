+++ 
draft = false
date = 2026-10-01T16:42:58+02:00
title = "Deduction Guides in C++17: Teaching the compiler to deduce your class templates"
tags = ["C++17", "deduction-guides", "CTAD"]
categories = ["C++"]
+++

Class Template Argument Deduction (CTAD) is one of the more understated C++17 features — it doesn't add power to the type system so much as remove a source of friction that every C++ programmer had learned to route around, usually with a `make_*` helper function. Deduction guides are the mechanism that makes CTAD work for your own types, and understanding them requires understanding _why_ CTAD needed a separate deduction mechanism at all, rather than just reusing function template argument deduction.

This post covers the problem CTAD solves, how the compiler synthesizes deduction guides implicitly, when and how to write your own, and the pitfalls that show up once you start applying this to real container-like or wrapper types.

## The problem: constructors don't participate in template argument deduction

Function templates have always supported argument deduction:

```cpp
template <typename T>
void print(T value) { /* ... */ }

print(42); // T deduced as int, no <int> needed
```

Class templates never had this. Before C++17, instantiating a class template required either explicit template arguments or a helper function that deduced them on your behalf:

```cpp
std::pair<int, double> p1(1, 2.0);        // fine, but redundant
auto p2 = std::make_pair(1, 2.0);         // std::pair<int, double>, deduced
```

`std::make_pair`, `std::make_tuple`, and later `std::make_unique`/`std::make_shared` all exist largely because of this gap. They are ordinary function templates, and function templates _could_ deduce their arguments — so the standard library routed construction through them rather than teaching constructors to do the same thing.

The reason this couldn't simply be "make constructors act like function templates" is that a constructor's job is to initialize an object whose type is already fixed by the point the constructor runs. Overload resolution for a constructor call `Foo(args)` needs to happen _before_ the compiler knows what `Foo<T>` actually is — there is no object, and hence no constructor overload set, until the template arguments are known. CTAD had to be layered on as a distinct, earlier step: before overload resolution proper, the compiler needs a way to guess `T` from the constructor arguments alone.

## Implicit deduction guides: synthesized from your constructors

C++17 solves this by defining a set of **deduction guides** for every class template — some synthesized automatically by the compiler, some written explicitly by you. A deduction guide is, conceptually, a function template signature:

```cpp
template <typename ...Params>
ClassName(ConstructorArgs...) -> ClassName<DeducedParams...>;
```

The left-hand side looks like a constructor call; the right-hand side (after `->`) is the class template specialization that call should deduce to. When you write:

```cpp
Widget w{1, 2.5};
```

the compiler builds a set of candidate deduction guides — matches them the way it would match overloaded functions — and picks one to determine `Widget<...>`, exactly as if it were resolving `w`'s type before resolving which constructor to call.

For an ordinary class template, the compiler synthesizes one implicit deduction guide **per constructor**, by substituting the constructor's parameter types wholesale. Given:

```cpp
template <typename T, typename U>
struct Widget {
    Widget(T t, U u) : t_(t), u_(u) {}
    T t_;
    U u_;
};
```

the compiler behaves as if this guide existed:

```cpp
template <typename T, typename U>
Widget(T, U) -> Widget<T, U>;
```

So `Widget w{1, 2.5}` deduces `Widget<int, double>` with zero extra code on your part. This is why most simple aggregates and value types "just work" with CTAD in C++17 without you ever writing a guide — the implicit guides generated from the constructors are usually exactly what you want.

There is also an implicit guide synthesized from the class template itself (the "copy deduction candidate"), which handles the case of constructing from an existing object of the same template:

```cpp
Widget<int, double> w1{1, 2.5};
Widget w2{w1}; // copy deduction candidate: deduces Widget<int, double>, not Widget<Widget<int,double>>
```

Without this special-cased guide, deducing from `w1` through the ordinary constructor-derived guides could plausibly instantiate `Widget<Widget<int,double>>` via an implicitly generated copy constructor guide — the copy deduction candidate exists specifically to make "deduce from an existing specialization" behave the way copy-initialization intuitively should.

## Where implicit guides are not enough

Implicit guides are a mechanical, syntactic transformation of constructor parameter lists. They know nothing about the _semantics_ of your type, and that's exactly where they fall short. The canonical example is a container built from an iterator pair.

```cpp
template <typename T>
class MyVector {
public:
    template <typename InputIt>
    MyVector(InputIt first, InputIt last) : data_(first, last) {}

private:
    std::vector<T> data_;
};
```

Constructing this from two iterators should deduce `T` as the iterators' value type:

```cpp
std::vector<std::string> src = {"a", "b", "c"};
MyVector v(src.begin(), src.end()); // we want MyVector<std::string>
```

But the implicit guide synthesized from the constructor is:

```cpp
template <typename T, typename InputIt>
MyVector(InputIt, InputIt) -> MyVector<T, InputIt>;
```

`T` here is a template parameter of the _class_, not the constructor — the constructor doesn't mention `T` anywhere in its parameter list, so there is nothing for the compiler to deduce it from. This guide is simply not viable for CTAD, and `T` cannot be inferred this way at all. The call fails to compile with a deduction error, because none of the implicitly generated guides can pin down `T`.

This is precisely the situation an explicit, user-written deduction guide exists to fix.

## Writing an explicit deduction guide

A deduction guide is declared at namespace scope, immediately following (by convention) the class definition it belongs to:

```cpp
template <typename InputIt>
MyVector(InputIt, InputIt) -> MyVector<typename std::iterator_traits<InputIt>::value_type>;
```

This tells the compiler, independently of any constructor: "if you see two arguments of the same iterator type `InputIt`, deduce `MyVector<value_type_of_InputIt>`." Now:

```cpp
MyVector v(src.begin(), src.end()); // MyVector<std::string>, via the explicit guide
```

`std::vector` itself needs exactly this guide for its own iterator-pair constructor, and the standard library provides it for you — which is why `std::vector v(src.begin(), src.end())` has always deduced correctly since C++17. You are, in effect, writing the same kind of guide the standard library authors wrote for `std::vector`, `std::map`, `std::set`, and friends.

A deduction guide is not a class member. C++ requires it to be declared in the same scope as the class template, typically immediately after the class at namespace scope:

```cpp
template <typename T>
class MyVector {
   public:
    template <typename InputIt>
    MyVector(InputIt first, InputIt last) : data_(first, last) {}

   private:
    std::vector<T> data_;
};

template <typename InputIt>
MyVector(InputIt first,
         InputIt last) -> MyVector<typename std::iterator_traits<InputIt>::value_type>;

int main() {
    std::vector<std::string> src{"a", "b", "c"};
    MyVector v(src.begin(), src.end());
}
```

Inside the class, that declaration is not valid member syntax. The constructor itself can be inside the class, but the trailing `-> MyVector<...>` form belongs to the separate deduction-guide declaration. Without an explicit guide, the compiler can only deduce template arguments from the constructor’s parameter types; here `T` doesn’t appear in those types.

A simpler and extremely common case is deducing from a single value with a type transformation, such as decaying array-to-pointer or stripping a reference:

```cpp
template <typename T>
struct Box {
    Box(T value) : value_(value) {}
    T value_;
};

template <typename T>
Box(T) -> Box<T>;   // redundant here — matches the implicit guide exactly
```

That particular guide adds nothing over the implicit one. A guide earns its place when it does something the constructor's literal parameter types cannot express — deducing from an _associated_ type (an iterator's `value_type`, a callable's return type, a range's element type) rather than the parameter's own type.

## A case where a guide changes the deduced type

Deduction guides aren't limited to filling gaps — they can override what an implicit guide would otherwise produce. A common pattern is a wrapper constructed from a `const char*` that should store `std::string`, not `const char*`:

```cpp
template <typename T>
struct Labeled {
    Labeled(T value) : value_(value) {}
    T value_;
};

Labeled l1{"hello"}; // implicit guide deduces T = const char*
```

If you want string literals to produce `Labeled<std::string>` instead, an explicit guide can redirect deduction:

```cpp
Labeled(const char*) -> Labeled<std::string>;
```

```cpp
Labeled l2{"hello"}; // now T = std::string, via the explicit guide
```

Both guides — the implicit one and this explicit one — are viable candidates for the same call; overload resolution among deduction guides picks the best match exactly as it would for ordinary function overloads, and a non-template guide taking `const char*` is a better match for a string literal than the templated implicit guide. This is the mechanism `std::basic_string`'s own guides rely on to keep raw string literals from silently deducing character-pointer specializations.

## Rules and constraints worth knowing

A few constraints shape how you can use guides in practice:

- **Namespace scope only.** A deduction guide must be declared in the same namespace as the class template (or an enclosing namespace reachable via ADL for the call). You cannot declare one inside the class body, and you cannot declare one for a class template that isn't visible at that scope.
- **No guides for non-template classes.** CTAD, and therefore deduction guides, only apply to class templates. An ordinary class never needs one.
- **The guide's return type must be a specialization of the class template it names** — you cannot deduce to an unrelated type.
- **Guides participate in overload resolution together with implicitly generated ones.** You don't need to (and generally shouldn't) duplicate a guide that would just restate an existing constructor's parameter list; write one only where deduction needs information the constructor signature doesn't carry, or where you deliberately want to override the default deduction.
- **Aggregates need CTAD support too, and got it later.** C++17 CTAD does not extend to aggregate initialization without a user-provided guide; C++20 closed most of that gap by synthesizing guides from aggregate members automatically. If your blog's target compiler set is strictly C++17, aggregate class templates typically still need an explicit guide to support brace-init CTAD.
- **Guides are unrelated to constructor visibility rules.** A deduction guide can reference a private constructor's behavior conceptually, but a guide itself doesn't grant access — the constructor actually selected after deduction still has to be accessible at the call site.

## Comparison: implicit guides vs. explicit guides

|                                                                                     | Implicit (compiler-generated)                                                                                       | Explicit (user-written)                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Source                                                                              | One synthesized per constructor, plus the copy deduction candidate                                                  | Written by the class author at namespace scope            |
| Can deduce from a parameter's own type                                              | Yes                                                                                                                 | Yes                                                       |
| Can deduce from an _associated_ type (e.g. iterator's `value_type`)                 | No — constructor's own template parameters aren't visible to CTAD unless they appear directly in the parameter list | Yes — the guide's return type can name any dependent type |
| Can override deduction for a specific overload (e.g. `const char*` → `std::string`) | No                                                                                                                  | Yes, via overload resolution among guides                 |
| Needed for a straightforward value-holding template (`Box<T>` from `Box(T)`)        | Usually sufficient on its own                                                                                       | Rarely needed                                             |
| Needed for iterator-pair / range-style constructors                                 | Not sufficient                                                                                                      | Required                                                  |

## Decision framework

- If your constructor's parameters directly mention every class template parameter, the implicit guide is almost certainly enough — don't add one.
- If a constructor parameter's type is only related to a class template parameter _indirectly_ (an iterator whose `value_type` you want, a container whose `element_type` you want, a callable whose return type you want), write an explicit guide naming that relationship.
- If you want a specific input type (commonly `const char*`, or an initializer-list form) to deduce a _different_ stored type than the constructor's literal parameter type would suggest, write a non-template or more specialized guide to win overload resolution for that case.
- If you're targeting strict C++17 and have an aggregate class template, plan to write a guide explicitly rather than relying on C++20-only aggregate deduction.
- When in doubt, compile a representative call and read the deduced type from a diagnostic (`static_assert(std::is_same_v<decltype(x), Expected>)` is a reliable way to pin this down during development, rather than trusting intuition about which guide wins).
