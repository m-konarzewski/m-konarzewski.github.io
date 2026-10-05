+++ 
draft = false
date = 2026-10-05T02:14:52+02:00
title = "Lesson 5 - Decoding video frames"
tags = ["video-decoding", "avcodec_send_packet", "avcodec_receive_frame"]
categories = ["FFmpeg"]
+++

Lesson 3 pulled compressed packets out of a container, and Lesson 4 introduced the vocabulary needed to read their timestamps: keyframes, I/P/B frames, GOPs, decode versus presentation order, PTS/DTS and time bases. This lesson takes the next step: feeding those packets to a decoder and getting raw frames (`AVFrame`) back.

The program built here opens a file, decodes every frame of the first video stream and prints one line per frame: PTS, DTS, presentation time in seconds, picture type and keyframe flag. The pixel data itself is not touched. The focus is the decoding machinery: the decoder context, the send/receive API, the meaning of `EAGAIN` and `AVERROR_EOF`, and draining.

## 1. Packets in, frames out

### Packets and frames

An `AVPacket` is a unit of _compressed_ data produced by the demuxer and tagged with the index of the stream it belongs to. An `AVFrame` is a unit of _decoded_ data: planes of raw pixels (or audio samples) plus metadata such as format, dimensions, timestamps, picture type and flags. Decoding is the conversion of the first into the second.

### A decoder is a codec plus state

Two structures are involved:

- `AVCodec` is a static description of a codec implementation: its name, the codec ID it handles and its entry points.
- `AVCodecContext` is one running instance of it: parameters, internal buffers, a pool of reference frames and, depending on the configuration, worker threads.

The state is not incidental. P- and B-frames are encoded as differences against other frames, so a decoder has to keep previously decoded pictures around. A "packet in, frame out" function without memory cannot exist for inter-frame codecs. One `AVCodecContext` therefore serves exactly one stream and must never be shared between streams.

### The send/receive API

Decoding is split into two decoupled calls:

```text
                 avcodec_send_packet                 avcodec_receive_frame
 AVPacket ─────────────────────────▶  [ decoder ]  ─────────────────────────▶ AVFrame
 (compressed)                                                                 (raw)
                    ▲                                         │
                    └──────── EAGAIN: more input needed ──────┘
```

`avcodec_send_packet()` hands one compressed packet to the decoder. `avcodec_receive_frame()` asks for one decoded frame. The two calls are not tied one-to-one: a packet may yield no frame yet, one frame, or several frames. The documented usage is to call `avcodec_receive_frame()` repeatedly after every successful send until it reports that it needs more input.

| Call                    | Result               | Meaning                                                                                        |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `avcodec_send_packet`   | `0`                  | Packet accepted.                                                                               |
|                         | `AVERROR(EAGAIN)`    | Input is refused in the current state; output must be read with `avcodec_receive_frame` first. |
|                         | `AVERROR_EOF`        | The decoder has been flushed; no more packets are accepted.                                    |
|                         | other negative value | Invalid state (`EINVAL`, `ENOMEM`) or a genuine decoding error.                                |
| `avcodec_receive_frame` | `0`                  | A frame was returned.                                                                          |
|                         | `AVERROR(EAGAIN)`    | No output available right now; more input has to be sent.                                      |
|                         | `AVERROR_EOF`        | The decoder is fully drained; no more frames will ever come.                                   |
|                         | other negative value | Decoding error.                                                                                |

The two `EAGAIN` values mean opposite things, which is the usual source of confusion. On the _receive_ side, `EAGAIN` is a normal condition: the decoder has nothing more to give until it gets another packet. On the _send_ side, `EAGAIN` would mean the decoder is full and output has to be consumed first. A loop that reads all pending frames after every send never sees the second case.

### Why frames lag behind packets

Frames leave the decoder in presentation order, while packets arrive in decode order (Lesson 4). A B-frame cannot be decoded before the later reference it depends on, and a frame cannot be released while a frame that precedes it in presentation order is still to come. The decoder therefore holds pictures back, and the first frame of a stream is typically available only after several packets have already been sent. For most video streams the total number of frames equals the total number of packets, but the output is _delayed_ relative to the input rather than synchronous with it.

### Draining

After the last packet, frames are still sitting inside the decoder. Sending a `nullptr` packet signals the end of the stream; the decoder then starts returning everything it still buffers, and `avcodec_receive_frame()` finally returns `AVERROR_EOF` once nothing is left. The first flush packet succeeds, any further one returns `AVERROR_EOF`, and a drained decoder accepts no more packets. Skipping this step silently drops the tail of the video.

### Ownership and lifetime

- **Packet.** Ownership stays with the caller. The decoder takes its own reference to the packet data (or copies it when the packet is not reference-counted), so the packet can be released with `av_packet_unref()` immediately after `avcodec_send_packet()` returns.
- **Frame.** `avcodec_receive_frame()` always calls `av_frame_unref()` on the frame before filling it and returns a reference-counted frame whose buffers are owned by the decoder's pool. An explicit `av_frame_unref()` after use releases the buffer reference at once instead of holding it until the next call. Pixel data pointers are valid only while the frame is referenced.

The same `AVPacket` and `AVFrame` objects are reused for the whole loop; allocating them once and unreferencing them in between is the intended pattern.

### What a decoded frame says about time and type

- `pts` is the presentation timestamp in the stream's time base. It can be `AV_NOPTS_VALUE`.
- `pkt_dts` is the DTS copied from the packet that _triggered_ the return of this frame (the header documents it as valid when frame threading is not in use). A frame returned during draining has no triggering packet, so the field is `AV_NOPTS_VALUE` there.
- `best_effort_timestamp` is FFmpeg's heuristic guess, usable as a fallback when `pts` is not set.
- Seconds are obtained as `pts * av_q2d(time_base)`. The time base is a property of the stream and differs between containers, so raw tick counts are only comparable within one stream.
- `pict_type` holds the picture type (`AV_PICTURE_TYPE_I`, `_P`, `_B`, ...), and `av_get_picture_type_char()` turns it into a letter.
- The keyframe flag lives in `frame->flags` as `AV_FRAME_FLAG_KEY`. Older material uses a `frame->key_frame` member, which no longer exists in current headers.

## 2. RAII for the C API

FFmpeg objects come with matching free functions, and the program has several early-return error paths. Releasing manually on each of them is exactly what `std::unique_ptr` with a custom deleter is for.

FFmpeg's free functions share one shape: they take a `T**` and set the pointee to `nullptr` after releasing the object. A single stateless deleter template covers all of them, with the function as a non-type template parameter:

```cpp
template <auto Free>
struct Deleter {
    template <typename T>
    void operator()(T* ptr) const noexcept
    {
        Free(&ptr);
    }
};

template <typename T, auto Free>
using Handle = std::unique_ptr<T, Deleter<Free>>;

using FormatContext = Handle<AVFormatContext, avformat_close_input>;
using CodecContext = Handle<AVCodecContext, avcodec_free_context>;
using Packet = Handle<AVPacket, av_packet_free>;
using Frame = Handle<AVFrame, av_frame_free>;
```

A few details are worth noting:

- `ptr` is the deleter's own parameter, a local copy, so passing `&ptr` to the C function is safe. FFmpeg nulls the copy and the `unique_ptr` has already given up ownership of the original.
- The deleter has no state, so in practice the `unique_ptr` stays the size of a raw pointer.
- An input opened with `avformat_open_input` has to be released with `avformat_close_input`, not `avformat_free_context`: the former also closes the underlying I/O, which is why it is the function plugged into `FormatContext`.

Two ways of acquiring an object appear in the program:

- Allocators that _return_ the pointer (`avcodec_alloc_context3`, `av_packet_alloc`, `av_frame_alloc`) feed straight into the `unique_ptr` constructor.
- `avformat_open_input` has a `T**` _output parameter_ and allocates the context itself. This is the shape `std::out_ptr` (C++23) adapts: the temporary adaptor converts to `AVFormatContext**`, and when the full expression ends, the adaptor's destructor resets the `unique_ptr` with whatever FFmpeg wrote. If the call fails, FFmpeg frees the context and writes `nullptr`, so the `unique_ptr` correctly stays empty. The mechanics of `std::out_ptr` are covered in this post on [out_ptr/inout_ptr](https://m-konarzewski.github.io/posts/out-ptr-and-inout-ptr/).

`std::out_ptr` needs a standard library that ships it; with libstdc++ that means GCC 14 or newer.

One more helper converts FFmpeg's numeric error codes into text:

```cpp
std::string error_string(int error)
{
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(error, buffer, sizeof(buffer));
    return buffer;
}
```

## 3. Walking through the code

The fragments below follow the order of execution. The first three repeat the setup from Lessons 2 and 3 so the program is complete on its own.

### `avformat_open_input`

```cpp
FormatContext format;
int ret = avformat_open_input(std::out_ptr(format), path, nullptr, nullptr);
if (ret < 0) {
    std::cerr << std::format("avformat_open_input failed: {}\n", error_string(ret));
    return 1;
}
```

Opens the file, detects the container format and reads its header. The context is allocated by the call itself and handed to `format` through `std::out_ptr`. Every later `return` releases it automatically.

### `avformat_find_stream_info`

```cpp
ret = avformat_find_stream_info(format.get(), nullptr);
if (ret < 0) {
    std::cerr << std::format("avformat_find_stream_info failed: {}\n", error_string(ret));
    return 1;
}
```

Reads a few packets and probes the codecs so that each stream's `codecpar` is filled in: dimensions, pixel format and so on. These values are what the decoder is configured from a few steps later.

### Selecting the video stream

```cpp
int video_index = -1;
for (unsigned i = 0; i < format->nb_streams; ++i) {
    if (format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        video_index = static_cast<int>(i);
        break;
    }
}
if (video_index < 0) {
    std::cerr << "No video stream found\n";
    return 1;
}
const AVStream* stream = format->streams[video_index];
```

The first stream whose `codec_type` is `AVMEDIA_TYPE_VIDEO` is used. The index is needed later to filter packets, and the `AVStream` is needed for its `time_base`.

### `avcodec_find_decoder`

```cpp
const AVCodec* decoder = avcodec_find_decoder(stream->codecpar->codec_id);
if (!decoder) {
    std::cerr << std::format("No decoder found for codec '{}'\n",
                             avcodec_get_name(stream->codecpar->codec_id));
    return 1;
}
```

Looks up a registered decoder for the stream's codec ID and returns the default one. A specific implementation can be requested by name with `avcodec_find_decoder_by_name`. The result is a pointer to a static description, so there is nothing to free.

### `avcodec_alloc_context3`

```cpp
CodecContext codec{avcodec_alloc_context3(decoder)};
if (!codec) {
    std::cerr << "avcodec_alloc_context3 failed\n";
    return 1;
}
```

Allocates a fresh `AVCodecContext` initialized with the defaults of the given decoder. It is still empty at this point: no dimensions, no pixel format, nothing codec-specific. The allocator returns the pointer directly, so it goes straight into the `unique_ptr`.

### `avcodec_parameters_to_context`

```cpp
ret = avcodec_parameters_to_context(codec.get(), stream->codecpar);
if (ret < 0) {
    std::cerr << std::format("avcodec_parameters_to_context failed: {}\n", error_string(ret));
    return 1;
}
```

Copies everything the demuxer learned about the stream into the context: codec ID, dimensions, pixel format, bitrate and, importantly, the codec's `extradata`. For many codecs the decoder cannot start without it (H.264 in MP4, for example, stores its parameter sets there).

### `avcodec_open2`

```cpp
ret = avcodec_open2(codec.get(), decoder, nullptr);
if (ret < 0) {
    std::cerr << std::format("avcodec_open2 failed: {}\n", error_string(ret));
    return 1;
}

const char* pixel_format = av_get_pix_fmt_name(codec->pix_fmt);
std::cout << std::format("Decoder: {} ({}), {}x{}, {}\n\n",
                         decoder->name,
                         decoder->long_name ? decoder->long_name : "",
                         codec->width,
                         codec->height,
                         pixel_format ? pixel_format : "unknown");
```

Initializes the decoder; from here on the context can accept packets. The last argument is an optional dictionary of decoder options and is not used here.

Resolution and pixel format belong to the stream, not to an individual frame, so they are printed once, right after the decoder is opened, instead of on every frame line. `av_get_pix_fmt_name()` turns the `AVPixelFormat` enum into its familiar name (`yuv420p` and so on) and returns `nullptr` for unknown values.

### `av_packet_alloc` and `av_frame_alloc`

```cpp
Packet packet{av_packet_alloc()};
Frame frame{av_frame_alloc()};
if (!packet || !frame) {
    std::cerr << "Failed to allocate packet or frame\n";
    return 1;
}
```

One `AVPacket` and one `AVFrame` are allocated and reused for the entire run. Both are empty shells; the demuxer fills the packet and the decoder fills the frame.

### `av_read_frame`

```cpp
while (true) {
    ret = av_read_frame(format.get(), packet.get());
    if (ret == AVERROR_EOF) {
        break;
    }
    if (ret < 0) {
        std::cerr << std::format("av_read_frame failed: {}\n", error_string(ret));
        return 1;
    }

    if (packet->stream_index != video_index) {
        av_packet_unref(packet.get());
        continue;
    }
    // ...
}
```

Reads the next packet of the file, whichever stream it belongs to (the same loop as in Lesson 3). `AVERROR_EOF` is the normal end of input and is told apart from a real error. Packets of other streams, audio in a typical file, are released and skipped: a video decoder must only ever see packets of its own stream.

### `avcodec_send_packet`

```cpp
ret = avcodec_send_packet(codec.get(), packet.get());
av_packet_unref(packet.get());
if (ret < 0) {
    std::cerr << std::format("avcodec_send_packet failed: {}\n", error_string(ret));
    return 1;
}
++counters.packets_sent;
```

Feeds the compressed packet to the decoder. The packet is unreferenced right after the call, regardless of the result, because the decoder holds its own reference to the data. Any negative value is treated as an error here, since `EAGAIN` cannot occur: the receive loop below drains all pending output after every send.

### `avcodec_receive_frame`

```cpp
int receive_frames(AVCodecContext* codec, AVFrame* frame, const AVStream* stream, Counters& counters)
{
    while (true) {
        const int ret = avcodec_receive_frame(codec, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            return 0;
        }
        if (ret < 0) {
            return ret;
        }

        print_frame(frame, stream, counters.frames_received);
        ++counters.frames_received;

        av_frame_unref(frame);
    }
}
```

Pulls every frame the decoder can currently deliver. The function returns `0` both for `EAGAIN` ("send more input") and for `AVERROR_EOF` ("fully drained"), because in both cases the loop has nothing more to do, and a negative error code for anything else. After each frame is handled, `av_frame_unref()` releases its buffers so the same `AVFrame` can be reused. The call is made after every successful `avcodec_send_packet()`, and zero, one or several frames may come out of it.

### Printing a frame

```cpp
std::string timestamp_string(std::int64_t timestamp)
{
    return timestamp != AV_NOPTS_VALUE ? std::format("{}", timestamp) : std::string{"N/A"};
}

void print_frame(const AVFrame* frame, const AVStream* stream, std::int64_t index)
{
    const std::int64_t pts =
        frame->pts != AV_NOPTS_VALUE ? frame->pts : frame->best_effort_timestamp;

    const std::string time_text =
        pts != AV_NOPTS_VALUE
            ? std::format("{:.4f}s", static_cast<double>(pts) * av_q2d(stream->time_base))
            : std::string{"N/A"};

    const bool is_key = (frame->flags & AV_FRAME_FLAG_KEY) != 0;

    std::cout << std::format(
        "frame #{:<6} pts={:<8} dts={:<8} t={:<11} type={} key={}\n",
        index,
        timestamp_string(pts),
        timestamp_string(frame->pkt_dts),
        time_text,
        av_get_picture_type_char(frame->pict_type),
        is_key ? 1 : 0);
}
```

`pts` falls back to `best_effort_timestamp` when the decoder did not set it. Time in seconds is the tick count multiplied by the stream's time base (`av_q2d()` converts the `AVRational` to a `double`). `pkt_dts` is printed as-is, with `N/A` standing in for `AV_NOPTS_VALUE`. The format string left-aligns every column, which keeps the log readable regardless of how many digits a timestamp has.

### Draining the decoder

```cpp
ret = avcodec_send_packet(codec.get(), nullptr);
if (ret < 0) {
    std::cerr << std::format("avcodec_send_packet (flush) failed: {}\n", error_string(ret));
    return 1;
}

ret = receive_frames(codec.get(), frame.get(), stream, counters);
if (ret < 0) {
    std::cerr << std::format("avcodec_receive_frame (flush) failed: {}\n", error_string(ret));
    return 1;
}
```

Once `av_read_frame()` reports the end of the file, a `nullptr` packet tells the decoder that the stream is over. The same `receive_frames()` helper then collects everything still buffered inside, finishing with `AVERROR_EOF`.

## 4. Reading the output

The first sample comes from an AVI file with an `msmpeg4v2` video stream, a codec without B-frames:

```text
Decoder: msmpeg4v2 (MPEG-4 part 2 Microsoft variant version 2), 1920x1080, yuv420p

frame #0      pts=0        dts=0        t=0.0000s     type=I key=1
frame #1      pts=1        dts=1        t=0.0417s     type=P key=0
frame #2      pts=2        dts=2        t=0.0833s     type=P key=0
frame #3      pts=3        dts=3        t=0.1250s     type=P key=0
frame #4      pts=4        dts=4        t=0.1667s     type=P key=0
...
frame #119    pts=119      dts=119      t=4.9583s     type=P key=0

Packets sent: 120, frames decoded: 120
```

- The stream-wide properties (decoder, resolution, pixel format) appear once in the header line.
- The time base of this stream is 1/24 s, so `pts` advances by one tick per frame and `t` by 1/24 s.
- Without B-frames, presentation and decode order coincide, `pts` equals `dts`, and the frame count equals the packet count.

The second sample is H.264 in MP4 with B-frames enabled:

```text
Decoder: h264 (H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10), 1280x720, yuv420p

frame #0      pts=0        dts=0        t=0.0000s     type=I key=1
frame #1      pts=512      dts=512      t=0.0417s     type=B key=0
frame #2      pts=1024     dts=1024     t=0.0833s     type=P key=0
frame #3      pts=1536     dts=1536     t=0.1250s     type=P key=0
frame #4      pts=2048     dts=2048     t=0.1667s     type=B key=0
frame #5      pts=2560     dts=2560     t=0.2083s     type=P key=0
...
frame #69     pts=35328    dts=35328    t=2.8750s     type=P key=0
frame #70     pts=35840    dts=N/A      t=2.9167s     type=B key=0
frame #71     pts=36352    dts=N/A      t=2.9583s     type=P key=0

Packets sent: 72, frames decoded: 72
```

- This stream uses a time base of 1/12288 s, so one frame at 24 fps is 512 ticks. The same video would show entirely different `pts` numbers in the AVI sample above, which is why timestamps are only meaningful together with their time base.
- B-frames are present in the stream, yet `pts` increases strictly from line to line: frames leave the decoder in presentation order, regardless of the order the packets arrived in.
- The `dts` column shows the DTS of the packet that triggered the frame's release. The last two frames have none (`N/A`): they were still inside the decoder after the final packet had been sent, and came out only during the drain stage. This is the reordering delay made visible, and the reason the drain stage cannot be omitted.

## 5. Common pitfalls

- **Skipping the drain.** The program still ends cleanly and reports no error; the last frames are simply missing.
- **Reading only one frame per packet.** Output has to be consumed in a loop until `EAGAIN`. A single `avcodec_receive_frame()` call per `avcodec_send_packet()` works until a packet produces more than one frame.
- **Sending packets of the wrong stream.** The `stream_index` check must come before `avcodec_send_packet()`.
- **Forgetting the unref calls.** Without `av_packet_unref()` and `av_frame_unref()` in the loop, buffers are held until the objects are freed.
- **Treating `frames == packets` as an invariant.** The relationship holds for many streams, but it is a property of the stream and codec, not a guarantee of the API.
- **Comparing timestamps across streams without the time base.** Tick counts are comparable only within one stream; seconds are not.

## Complete program

```cpp
#include <cstdint>
#include <format>
#include <iostream>
#include <memory>
#include <string>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/pixdesc.h>
}

// Adapter for FFmpeg's "free" functions, which all share the same shape:
// they take a T** and set the pointee to nullptr after releasing it.
// The function itself is a non-type template parameter, so the deleter is
// stateless and unique_ptr stays the size of a raw pointer.
template <auto Free>
struct Deleter {
    template <typename T>
    void operator()(T* ptr) const noexcept
    {
        Free(&ptr);
    }
};

template <typename T, auto Free>
using Handle = std::unique_ptr<T, Deleter<Free>>;

using FormatContext = Handle<AVFormatContext, avformat_close_input>;
using CodecContext = Handle<AVCodecContext, avcodec_free_context>;
using Packet = Handle<AVPacket, av_packet_free>;
using Frame = Handle<AVFrame, av_frame_free>;

struct Counters {
    std::int64_t packets_sent = 0;
    std::int64_t frames_received = 0;
};

std::string error_string(int error)
{
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(error, buffer, sizeof(buffer));
    return buffer;
}

std::string timestamp_string(std::int64_t timestamp)
{
    return timestamp != AV_NOPTS_VALUE ? std::format("{}", timestamp) : std::string{"N/A"};
}

void print_frame(const AVFrame* frame, const AVStream* stream, std::int64_t index)
{
    // Not every demuxer/decoder combination fills frame->pts, so fall back
    // to the timestamp FFmpeg guessed for the frame.
    const std::int64_t pts =
        frame->pts != AV_NOPTS_VALUE ? frame->pts : frame->best_effort_timestamp;

    const std::string time_text =
        pts != AV_NOPTS_VALUE
            ? std::format("{:.4f}s", static_cast<double>(pts) * av_q2d(stream->time_base))
            : std::string{"N/A"};

    const bool is_key = (frame->flags & AV_FRAME_FLAG_KEY) != 0;

    std::cout << std::format(
        "frame #{:<6} pts={:<8} dts={:<8} t={:<11} type={} key={}\n",
        index,
        timestamp_string(pts),
        timestamp_string(frame->pkt_dts),
        time_text,
        av_get_picture_type_char(frame->pict_type),
        is_key ? 1 : 0);
}

// Pulls every frame the decoder can currently give us.
// Returns 0 when the decoder needs more input (EAGAIN) or is fully drained (EOF),
// a negative AVERROR code on a real decoding error.
int receive_frames(AVCodecContext* codec, AVFrame* frame, const AVStream* stream, Counters& counters)
{
    while (true) {
        const int ret = avcodec_receive_frame(codec, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            return 0;
        }
        if (ret < 0) {
            return ret;
        }

        print_frame(frame, stream, counters.frames_received);
        ++counters.frames_received;

        av_frame_unref(frame);
    }
}

int run(const char* path)
{
    // 1. Open the container. avformat_open_input takes an AVFormatContext**
    //    and allocates the context itself, which is exactly the shape
    //    std::out_ptr adapts: the unique_ptr is reset with the new pointer
    //    once the full expression ends (and stays empty if the call failed,
    //    because FFmpeg frees the context and nulls it on error).
    FormatContext format;
    int ret = avformat_open_input(std::out_ptr(format), path, nullptr, nullptr);
    if (ret < 0) {
        std::cerr << std::format("avformat_open_input failed: {}\n", error_string(ret));
        return 1;
    }

    ret = avformat_find_stream_info(format.get(), nullptr);
    if (ret < 0) {
        std::cerr << std::format("avformat_find_stream_info failed: {}\n", error_string(ret));
        return 1;
    }

    // 2. Find the first video stream.
    int video_index = -1;
    for (unsigned i = 0; i < format->nb_streams; ++i) {
        if (format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            video_index = static_cast<int>(i);
            break;
        }
    }
    if (video_index < 0) {
        std::cerr << "No video stream found\n";
        return 1;
    }
    const AVStream* stream = format->streams[video_index];

    // 3. Find a decoder for the stream's codec.
    const AVCodec* decoder = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!decoder) {
        std::cerr << std::format("No decoder found for codec '{}'\n",
                                 avcodec_get_name(stream->codecpar->codec_id));
        return 1;
    }

    // 4. Create the decoder context (the allocator returns the pointer
    //    directly, so it is handed straight to the unique_ptr) and fill it
    //    from the stream parameters.
    CodecContext codec{avcodec_alloc_context3(decoder)};
    if (!codec) {
        std::cerr << "avcodec_alloc_context3 failed\n";
        return 1;
    }

    ret = avcodec_parameters_to_context(codec.get(), stream->codecpar);
    if (ret < 0) {
        std::cerr << std::format("avcodec_parameters_to_context failed: {}\n", error_string(ret));
        return 1;
    }

    // 5. Open the decoder.
    ret = avcodec_open2(codec.get(), decoder, nullptr);
    if (ret < 0) {
        std::cerr << std::format("avcodec_open2 failed: {}\n", error_string(ret));
        return 1;
    }

    // Resolution and pixel format are properties of the stream, not of a
    // single frame, so they are printed once here.
    const char* pixel_format = av_get_pix_fmt_name(codec->pix_fmt);
    std::cout << std::format("Decoder: {} ({}), {}x{}, {}\n\n",
                             decoder->name,
                             decoder->long_name ? decoder->long_name : "",
                             codec->width,
                             codec->height,
                             pixel_format ? pixel_format : "unknown");

    // 6. Allocate the reusable packet and frame.
    Packet packet{av_packet_alloc()};
    Frame frame{av_frame_alloc()};
    if (!packet || !frame) {
        std::cerr << "Failed to allocate packet or frame\n";
        return 1;
    }

    Counters counters;

    // 7. Demux -> send packet -> receive frames.
    while (true) {
        ret = av_read_frame(format.get(), packet.get());
        if (ret == AVERROR_EOF) {
            break;
        }
        if (ret < 0) {
            std::cerr << std::format("av_read_frame failed: {}\n", error_string(ret));
            return 1;
        }

        if (packet->stream_index != video_index) {
            av_packet_unref(packet.get());
            continue;
        }

        ret = avcodec_send_packet(codec.get(), packet.get());
        av_packet_unref(packet.get());
        if (ret < 0) {
            std::cerr << std::format("avcodec_send_packet failed: {}\n", error_string(ret));
            return 1;
        }
        ++counters.packets_sent;

        ret = receive_frames(codec.get(), frame.get(), stream, counters);
        if (ret < 0) {
            std::cerr << std::format("avcodec_receive_frame failed: {}\n", error_string(ret));
            return 1;
        }
    }

    // 8. Drain the decoder: a null packet signals end of stream and makes the
    //    decoder release the frames it is still holding internally.
    ret = avcodec_send_packet(codec.get(), nullptr);
    if (ret < 0) {
        std::cerr << std::format("avcodec_send_packet (flush) failed: {}\n", error_string(ret));
        return 1;
    }

    ret = receive_frames(codec.get(), frame.get(), stream, counters);
    if (ret < 0) {
        std::cerr << std::format("avcodec_receive_frame (flush) failed: {}\n", error_string(ret));
        return 1;
    }

    std::cout << std::format("\nPackets sent: {}, frames decoded: {}\n",
                             counters.packets_sent,
                             counters.frames_received);
    return 0;
}

int main(int argc, char* argv[])
{
    if (argc != 2) {
        std::cerr << std::format("Usage: {} <input file>\n", argv[0]);
        return 1;
    }

    return run(argv[1]);
}
```

## Where to find the code

The full set of lessons for this series lives in the companion repository: [https://github.com/m-konarzewski/FFmpeg-tutorial](https://github.com/m-konarzewski/FFmpeg-tutorial). Clone it and build following the instructions in that repo.
