+++ 
draft = false
date = 2026-09-23T02:14:52+02:00
title = "Lesson 4 - Keyframe, GOP, timestamps: Vocabulary before decoding"
tags = ["keyframe", "GOP", "pts", "dts", "timebase", "framerate"]
categories = ["FFmpeg"]
+++

Lessons 2 and 3 got you as far as reading packets out of a container without decoding anything. Before writing the code that actually turns those packets into pixels, it's worth slowing down on a handful of terms that get thrown around constantly in FFmpeg's API and its documentation — `AV_PKT_FLAG_KEY`, `pts`, `dts`, `time_base`, `avg_frame_rate` all appeared in Lesson 3 already, printed but not really explained. This post is that explanation: no code, just the concepts a decoder implementation leans on.

## Frame types: I, P, and B

Video codecs don't encode every frame the same way. Encoding each frame completely independently, from scratch, would be enormously wasteful — consecutive frames in real video are usually almost identical to their neighbors, so codecs exploit that redundancy instead of throwing it away.

- **I-frame (intra-coded frame)** — encoded using only information from within itself, exactly like a still image (conceptually similar to a JPEG). It doesn't reference any other frame, which means it can be decoded entirely on its own.
- **P-frame (predicted frame)** — encoded as a _difference_ from an earlier frame (usually the most recent I- or P-frame). Rather than storing a full image, it mostly stores what changed — motion vectors and residual data — which is far smaller than a full frame.
- **B-frame (bidirectionally predicted frame)** — like a P-frame, but predicted from frames on _both_ sides of it in presentation order: one earlier, one later. This compresses even better than a P-frame, at the cost of needing a "future" frame to already be available before a B-frame can be decoded — which is exactly the wrinkle that makes decode order and presentation order diverge, covered below.

## Keyframe

A **keyframe** is the general term for a frame that can be decoded without needing any other frame first — in practice, an I-frame. The word matters beyond terminology because keyframes are the only valid entry points into a compressed stream: seeking to an arbitrary timestamp means seeking to the _nearest keyframe at or before it_, then decoding forward from there, because a P- or B-frame decoded in isolation, without its reference frames already decoded, is meaningless data. This is also why `packet->flags & AV_PKT_FLAG_KEY`, printed in Lesson 3, is worth paying attention to: it's the only reliable signal, at the packet level, of where you're allowed to start decoding.

## GOP (Group of Pictures)

A **GOP** is the run of frames starting at one keyframe and extending up to (but not including) the next keyframe — one I-frame followed by some number of P-frames and B-frames that all, directly or transitively, depend on it. GOP length is a direct trade-off: a longer GOP (fewer keyframes) compresses better, since I-frames are the most expensive frame type to store, but it makes seeking coarser (bigger gaps between valid entry points) and makes the stream more fragile to data loss (drop or corrupt one frame, and everything depending on it downstream is also unrecoverable until the next keyframe). Live-streaming setups typically force short, regular GOPs specifically to bound both seek latency and error-recovery time; a locally stored archival file can get away with much longer ones.

A **closed GOP** doesn't reference any frame outside itself — clean to splice or seek into. An **open GOP** allows B-frames at the very start of a GOP to reference the _last_ frame of the _previous_ GOP, squeezing out a little more compression at the cost of that GOP no longer being fully independent — relevant if you're ever cutting a stream at GOP boundaries without re-encoding.

## Decode order vs. presentation order

This is the part that trips people up the first time, and it's the direct consequence of B-frames existing. Consider three frames that should be _displayed_ in this order: I, B, P. The B-frame is predicted from both the I-frame before it and the P-frame after it — which means the P-frame has to already be decoded _before_ the B-frame can be decoded, even though the P-frame is displayed _after_ it.

So the stream's **decode order** — the order packets actually need to be fed to the decoder — is different from its **presentation order** — the order the resulting frames should be shown to the viewer:

```
Presentation order:  I  B  P
Decode order:        I  P  B
```

The decoder consumes packets in decode order, and produces frames that then have to be reordered back into presentation order before display — the decoder itself (or the code driving it) is responsible for that reordering, using exactly the two timestamps below to know how.

## PTS and DTS

- **DTS (Decode Timestamp)** — when this packet should be fed to the decoder, in decode order.
- **PTS (Presentation Timestamp)** — when the resulting frame should actually be shown to the viewer, in presentation order.

For a stream with no B-frames, PTS and DTS are identical for every packet — decode order and presentation order are the same thing, so there's nothing to distinguish. The moment B-frames are involved, they diverge, exactly matching the I/B/P example above: the P-frame's packet has a DTS earlier than its PTS would suggest (it needs decoding before it's shown, to serve as a reference for the B-frame that comes before it in presentation order but after it in decode order), and the B-frame's packet has a DTS that comes after frames that will be presented before it.

This is also precisely why both fields exist on `AVPacket` rather than just one: a decoder needs DTS to know when to _process_ a packet, and needs the resulting frame's PTS to know when to _show_ it — two different questions with two different answers whenever reordering is in play.

## Time base

Every timestamp above is meaningless without knowing what unit it's measured in — and FFmpeg doesn't use a single fixed unit throughout. A **time base** is a rational number (`AVRational`, a numerator/denominator pair) that says "one tick of this timestamp equals this many seconds." A `time_base` of `{1, 90000}` means each unit is 1/90000th of a second — a common choice for MPEG-derived formats — while `{1, 25}` would mean each unit is a twenty-fifth of a second, matching a 25 fps stream exactly.

Two different time bases already showed up earlier in this series without being named as such: `fmt_ctx->duration` is expressed in the fixed constant `AV_TIME_BASE` (microseconds) regardless of the source format, while every `AVStream`'s own `pts`/`dts` values are expressed in that _stream's own_ `time_base`, which varies by container and codec and can differ between the video and audio streams in the very same file. Converting a timestamp from one time base to another — or to real seconds — means multiplying by the ratio of the two rationals; FFmpeg provides `av_rescale_q` to do this correctly, which becomes essential the moment you're handling multiple streams with different time bases at once, such as when muxing.

## Frame rate

Frame rate sounds like it should be a single simple number, and for many files it is — but the API distinguishes a couple of related fields for good reason. `AVStream::avg_frame_rate`, used in previous lesson, is the _average_ frame rate across the stream, computed (where possible) from the container's own timing metadata — appropriate for constant-frame-rate content, but only an average for anything that isn't. Variable frame rate content (screen recordings, some camera output) doesn't have one true "frame rate" at all — frames simply arrive at whatever timestamps they were captured at, and `avg_frame_rate` is exactly what it says: an average, not a guarantee that every frame is evenly spaced. This is worth keeping in mind once you're doing anything timing-sensitive with decoded frames, rather than assuming a fixed inter-frame interval implied by a single frame-rate number.

This lesson doesn't contain any C++ implementations to launch.
