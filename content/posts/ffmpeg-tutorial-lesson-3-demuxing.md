+++ 
draft = false
date = 2026-09-22T01:47:57+02:00
title = "Lesson 3 - Demuxing: reading packets from video file"
tags = ["demuxing", "av_read_frame", "AVPacket"]
categories = ["FFmpeg"]
+++

Lesson 2 opened a container and read its metadata, but never touched the actual media data. This post picks up right where that left off: same `avformat_open_input`/`avformat_find_stream_info` setup, now followed by a read loop that pulls compressed packets out of the file one at a time — for both the video and audio streams this time. Still no decoding — a packet is still compressed data — but this is the loop everything later in the series (decoding, transcoding, filtering) gets wrapped around.

## What a packet actually is

Before the code: an `AVPacket` is a chunk of _still-encoded_ data belonging to exactly one stream — one compressed video frame's worth of H.264 NAL units, or one MP3 frame's worth of audio samples, still in their compressed form. It is emphatically not an `AVFrame` (raw, decoded pixels or samples) — we won't touch `AVFrame` until another post, once a decoder is actually involved. Demuxing only ever produces packets; turning a packet into a frame is the decoder's job, one layer up from where this post stops.

## Includes and setup

```cpp
extern "C" {
#include <libavformat/avformat.h>
}

#include <format>
#include <iostream>
```

Same includes as previous lesson — `libavformat/avformat.h` for the demuxing API. `AVPacket` itself is declared in `libavformat/avformat.h` already, so no new headers are strictly required for packet reading on its own.

## `avformat_open_input` and `avformat_find_stream_info`

```cpp
AVFormatContext* fmt_ctx = nullptr;

int ret = avformat_open_input(&fmt_ctx, input_path, nullptr, nullptr);
if (ret < 0) {
    char err_buf[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(ret, err_buf, sizeof(err_buf));
    std::cerr << std::format("avformat_open_input failed: {}\n", err_buf);
    return 1;
}

ret = avformat_find_stream_info(fmt_ctx, nullptr);
if (ret < 0) {
    char err_buf[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(ret, err_buf, sizeof(err_buf));
    std::cerr << std::format("avformat_find_stream_info failed: {}\n", err_buf);
    avformat_close_input(&fmt_ctx);
    return 1;
}
```

Nothing new here from previous post: `avformat_open_input` probes the file and allocates `fmt_ctx`, and `avformat_find_stream_info` fills in whatever stream-level details the container header alone didn't provide. Both remain a precondition for everything below — without a fully populated `fmt_ctx`, there's no way to know which stream index corresponds to video versus audio, which is exactly what the next fragment figures out.

## Locating the video and audio streams

```cpp
int video_stream_index = -1;
int audio_stream_index = -1;

for (unsigned int i = 0; i < fmt_ctx->nb_streams; ++i) {
    if (fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        video_stream_index = static_cast<int>(i);
        continue;
    } else if (fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        audio_stream_index = static_cast<int>(i);
        continue;
    }
}
```

Here we need both a video and an audio stream index, so the loop has to walk every stream in the container rather than stopping early — a `break` on the first video match would risk never reaching an audio stream that comes later in the array. As before, neither index is assumed to be `0`; a file with multiple audio tracks or an unusual stream order would silently break that assumption, so both indices are resolved by type, not by position.

It's also worth being explicit about what this loop does _not_ handle: a real-world file can easily contain more than one video stream (alternate angles, a thumbnail track alongside the main video) or more than one audio stream (multiple languages, a commentary track, separate stereo and surround mixes). Because the loop simply overwrites `video_stream_index`/`audio_stream_index` on every match rather than collecting them into a list, it ends up keeping only the _last_ video stream and the _last_ audio stream it finds — any earlier ones are silently discarded. That's a deliberate simplification for this post, not a general-purpose solution: it's the right amount of code for a file with exactly one video and one audio stream, which covers most simple test files, but a program meant to handle arbitrary real-world media would need to collect all matching indices (into a `std::vector<int>`, for instance) and let the caller choose which one to use, rather than assuming there's only ever one of each.

## `av_packet_alloc`

```cpp
AVPacket* packet = av_packet_alloc();
if (!packet) {
    std::cerr << "av_packet_alloc failed\n";
    avformat_close_input(&fmt_ctx);
    return 1;
}
```

Unlike `AVFormatContext`, which `avformat_open_input` allocates for you, an `AVPacket` needs to be allocated explicitly before you can read into it. `av_packet_alloc` returns a zero-initialized packet with its internal reference-counted buffer left empty — the buffer only gets attached once `av_read_frame` fills it in. It can fail (return `nullptr`) under memory pressure, so it's worth checking like any other allocation, unusual as that feels for a small struct. Note this happens _after_ the stream-index scan above — at this point in the program we already know which streams we care about, and only now do we allocate the packet we'll read into repeatedly.

## The read loop: `av_read_frame`

```cpp
int packet_count = 0;
int video_packet_count = 0;
int audio_packet_count = 0;

while (true) {
    int ret = av_read_frame(fmt_ctx, packet);
    if (ret < 0) {
        if (ret == AVERROR_EOF) {
            std::cout << "EOF\n";
            break;
        } else {
            char err_buf[AV_ERROR_MAX_STRING_SIZE];
            av_strerror(ret, err_buf, sizeof(err_buf));
            std::cerr << std::format("av_read_frame failed: {}\n", err_buf);
            break;
        }
    }

    if (packet->stream_index == video_stream_index) {
        ++video_packet_count;
        const char* keyframe = (packet->flags & AV_PKT_FLAG_KEY) ? "yes" : "no";
        std::cout << std::format("Video packet #{}: pts={} dts={} size={} bytes, keyframe={}\n", video_packet_count,
                                 packet->pts, packet->dts, packet->size, keyframe);
    } else if (packet->stream_index == audio_stream_index) {
        ++audio_packet_count;
        std::cout << std::format("Audio packet #{}: pts={} dts={} size={} bytes\n", audio_packet_count, packet->pts,
                                 packet->dts, packet->size);
    }

    ++packet_count;
    av_packet_unref(packet);
}

std::cout << std::format("\nTotal packets read: {}\n", packet_count);
std::cout << std::format("Video packets: {}\n", video_packet_count);
std::cout << std::format("Audio packets: {}\n", audio_packet_count);
```

`av_read_frame` is the core of demuxing: each call reads the next packet from the container, from _whichever stream comes next in the file_ — video and audio packets are interleaved in roughly presentation order on disk, not grouped by stream, which is exactly why `packet->stream_index` exists: it tells you which `AVStream` (and therefore which codec) this particular packet belongs to. The `if`/`else if` on `stream_index` routes each packet to the right counter and print statement, and any packet belonging to neither tracked index (a subtitle stream, say) is silently skipped.

This version's loop condition is more deliberate than a bare `while (av_read_frame(...) >= 0)`: a negative return from `av_read_frame` can mean two different things, and this code distinguishes them explicitly. `AVERROR_EOF` is a specific, well-defined sentinel value meaning "there is nothing left to read" — a normal, expected way for the loop to end, so it's handled as a plain `break` with an informational message rather than an error path. Any _other_ negative value is a genuine error (a corrupted packet, an I/O failure partway through the file, and so on), and gets `av_strerror` and reported to `stderr` before breaking.

`packet->pts`/`packet->dts` are the presentation and decode timestamps, in the stream's own timebase (`AVStream::time_base` — a per-stream rational, distinct from the `AV_TIME_BASE` constant used for the container-level duration in previous post). `packet->size` is the size of the compressed data in bytes. For video packets, `packet->flags & AV_PKT_FLAG_KEY` checks whether the packet contains a keyframe (an intra-coded frame decodable without any preceding frames) — relevant for seeking and GOP structure, which come back once we're decoding. Audio packets are printed without a keyframe column: audio codecs generally don't have the same dependent-frame structure video codecs do, so the flag isn't meaningful there in the same way, and the output reflects that rather than printing a column that would just always read "yes."

## Packet lifetime: `av_packet_unref`

The `av_packet_unref(packet)` call at the end of each loop iteration is easy to skip and easy to regret skipping. `av_read_frame` doesn't allocate a fresh `AVPacket` each call — it reuses the one you passed in, attaching a new underlying, reference-counted data buffer to it each time. `av_packet_unref` releases that buffer's reference (freeing the underlying memory once nothing else references it) and resets the packet's fields back to their empty state, ready for the next `av_read_frame` call. Skip it, and each iteration leaks the previous packet's buffer — for a video file with tens of thousands of packets, that's a fast, silent memory leak rather than an obvious crash, which makes it an easy bug to miss in a quick test run and a nasty one to track down later.

## Cleanup: `av_packet_free`

```cpp
av_packet_free(&packet);
avformat_close_input(&fmt_ctx);
```

`av_packet_free` is the counterpart to `av_packet_alloc` — it releases the packet struct itself (and any buffer reference still attached, though the loop above already cleared that on every iteration via `av_packet_unref`), and nulls out the pointer, matching the `T**`-takes-a-pointer-to-pointer convention already seen with `avformat_close_input`. `avformat_close_input` then tears down the format context as it did in previous post.

## Full listing

```cpp
extern "C" {
#include <libavformat/avformat.h>
}

#include <format>
#include <iostream>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << std::format("usage: {} <input file>\n", argv[0]);
        return 1;
    }

    const char* input_path = argv[1];
    AVFormatContext* fmt_ctx = nullptr;

    int ret = avformat_open_input(&fmt_ctx, input_path, nullptr, nullptr);
    if (ret < 0) {
        char err_buf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, err_buf, sizeof(err_buf));
        std::cerr << std::format("avformat_open_input failed: {}\n", err_buf);
        return 1;
    }

    ret = avformat_find_stream_info(fmt_ctx, nullptr);
    if (ret < 0) {
        char err_buf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, err_buf, sizeof(err_buf));
        std::cerr << std::format("avformat_find_stream_info failed: {}\n", err_buf);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    int video_stream_index = -1;
    int audio_stream_index = -1;

    for (unsigned int i = 0; i < fmt_ctx->nb_streams; ++i) {
        if (fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            video_stream_index = static_cast<int>(i);
        } else if (fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            audio_stream_index = static_cast<int>(i);
        }
    }

    AVPacket* packet = av_packet_alloc();
    if (!packet) {
        std::cerr << "av_packet_alloc failed\n";
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    int packet_count = 0;
    int video_packet_count = 0;
    int audio_packet_count = 0;

    while (true) {
        int ret = av_read_frame(fmt_ctx, packet);
        if (ret < 0) {
            if (ret == AVERROR_EOF) {
                std::cout << "EOF\n";
                break;
            } else {
                char err_buf[AV_ERROR_MAX_STRING_SIZE];
                av_strerror(ret, err_buf, sizeof(err_buf));
                std::cerr << std::format("av_read_frame failed: {}\n", err_buf);
                break;
            }
        }

        if (packet->stream_index == video_stream_index) {
            ++video_packet_count;
            const char* keyframe = (packet->flags & AV_PKT_FLAG_KEY) ? "yes" : "no";
            std::cout << std::format("Video packet #{}: pts={} dts={} size={} bytes, keyframe={}\n", video_packet_count,
                                     packet->pts, packet->dts, packet->size, keyframe);
        } else if (packet->stream_index == audio_stream_index) {
            ++audio_packet_count;
            std::cout << std::format("Audio packet #{}: pts={} dts={} size={} bytes\n", audio_packet_count, packet->pts,
                                     packet->dts, packet->size);
        }

        ++packet_count;
        av_packet_unref(packet);
    }

    std::cout << std::format("\nTotal packets read: {}\n", packet_count);
    std::cout << std::format("Video packets: {}\n", video_packet_count);
    std::cout << std::format("Audio packets: {}\n", audio_packet_count);

    av_packet_free(&packet);
    avformat_close_input(&fmt_ctx);
}
```

Here's an example output of launching the application from the current lesson:

```bash
ragdoll@ragdoll:~/repo/FFmpeg-tutorial$ ./build/debug/Debug/lesson-3 ~/Videos/big_buck_bunny_1080p_stereo.avi
Audio packet #1: pts=0 dts=0 size=480 bytes
Audio packet #2: pts=1 dts=1 size=576 bytes
Audio packet #3: pts=2 dts=2 size=672 bytes
Audio packet #4: pts=3 dts=3 size=672 bytes
Audio packet #5: pts=4 dts=4 size=672 bytes
Audio packet #6: pts=5 dts=5 size=672 bytes
Audio packet #7: pts=6 dts=6 size=576 bytes
Audio packet #8: pts=7 dts=7 size=672 bytes
Audio packet #9: pts=8 dts=8 size=672 bytes
Audio packet #10: pts=9 dts=9 size=672 bytes
Audio packet #11: pts=10 dts=10 size=672 bytes
Audio packet #12: pts=11 dts=11 size=768 bytes
Audio packet #13: pts=12 dts=12 size=672 bytes
Audio packet #14: pts=13 dts=13 size=576 bytes
Audio packet #15: pts=14 dts=14 size=768 bytes
Audio packet #16: pts=15 dts=15 size=768 bytes
Audio packet #17: pts=16 dts=16 size=768 bytes
Audio packet #18: pts=17 dts=17 size=768 bytes
Audio packet #19: pts=18 dts=18 size=960 bytes
Audio packet #20: pts=19 dts=19 size=672 bytes
Audio packet #21: pts=20 dts=20 size=768 bytes
Video packet #1: pts=0 dts=0 size=22445 bytes, keyframe=yes
Audio packet #22: pts=21 dts=21 size=960 bytes
Audio packet #23: pts=22 dts=22 size=672 bytes
Video packet #2: pts=1 dts=1 size=1021 bytes, keyframe=no
Audio packet #24: pts=23 dts=23 size=960 bytes
Audio packet #25: pts=24 dts=24 size=768 bytes
Video packet #3: pts=2 dts=2 size=1021 bytes, keyframe=no
Audio packet #26: pts=25 dts=25 size=768 bytes
Audio packet #27: pts=26 dts=26 size=960 bytes
Video packet #4: pts=3 dts=3 size=1021 bytes, keyframe=no
...
Video packet #14303: pts=14302 dts=14302 size=19550 bytes, keyframe=no
Video packet #14304: pts=14303 dts=14303 size=19303 bytes, keyframe=no
Video packet #14305: pts=14304 dts=14304 size=21330 bytes, keyframe=no
Video packet #14306: pts=14305 dts=14305 size=21458 bytes, keyframe=no
Video packet #14307: pts=14306 dts=14306 size=22552 bytes, keyframe=no
Video packet #14308: pts=14307 dts=14307 size=22249 bytes, keyframe=no
Video packet #14309: pts=14308 dts=14308 size=23080 bytes, keyframe=no
Video packet #14310: pts=14309 dts=14309 size=21799 bytes, keyframe=no
Video packet #14311: pts=14310 dts=14310 size=22260 bytes, keyframe=no
Video packet #14312: pts=14311 dts=14311 size=22967 bytes, keyframe=no
Video packet #14313: pts=14312 dts=14312 size=23603 bytes, keyframe=no
Video packet #14314: pts=14313 dts=14313 size=22892 bytes, keyframe=no
Video packet #14315: pts=14314 dts=14314 size=22445 bytes, keyframe=yes
EOF

Total packets read: 39166
Video packets: 14315
Audio packets: 24851
```

## Where to find the code

The full set of lessons for this series lives in the companion repository: [https://github.com/m-konarzewski/FFmpeg-tutorial](https://github.com/m-konarzewski/FFmpeg-tutorial). Clone it and build following the instructions in that repo.
