+++ 
draft = false
date = 2026-10-12T20:37:16+02:00
title = "Lesson 6 - Playing Video"
tags = ["playing-video", "video-player", "sdl3"]
categories = ["FFmpeg"]
+++

Lesson 5 decoded the video stream of a file and printed one line per frame. This lesson puts those frames on the screen. A window opens, every decoded frame is uploaded to a texture at the right moment, and the file plays at its natural speed. The result is a small but complete video player built from a handful of focused classes.

Two libraries cooperate here, and each stays out of the other's way. FFmpeg turns a file into raw frames. SDL turns raw frames into pixels in a window. The player is the glue between the two, and most of the interesting work is in that glue: choosing a pixel format that needs no conversion, deciding _when_ a frame is due, and keeping the lifetimes of window, renderer and texture in the right order.

The player is video-only. There is no audio, no pause and no seeking, and the section on scope at the end lists what that implies.

## 1. What is SDL?

**SDL** (Simple DirectMedia Layer) is a free, cross-platform library written in C. It gives a program one uniform way to use the parts of a computer that games and media applications need: windows, keyboard, mouse and gamepad input, graphics output, audio and timers. The same source code builds and runs on Linux, Windows, macOS and mobile systems.

The reason it exists is that every operating system does these things differently. Windows has Win32, macOS has Cocoa, Linux has X11 and Wayland. Drawing goes through yet another layer of APIs: Direct3D, Metal, Vulkan, OpenGL. A program that talks to all of them directly would need a separate implementation per platform. SDL hides them behind one small API and selects the right backend at runtime.

For a video player the division of labour is clean:

```text
 file ──▶ FFmpeg (demux + decode) ──▶ AVFrame ──▶ SDL (texture + renderer) ──▶ window
```

FFmpeg knows nothing about windows or screens. SDL knows nothing about codecs or containers. A frame is the only thing that crosses the boundary.

This lesson uses **SDL3**, the current major version of the library. A few conventions are worth knowing up front:

- The header is `<SDL3/SDL.h>` and every public name starts with `SDL_`.
- Most functions that can fail return `bool` (`true` means success). Functions that create something return a pointer, and `nullptr` means failure.
- The text of the last error is available from `SDL_GetError()`.
- The library is initialized with `SDL_Init()` and shut down with `SDL_Quit()`.

The SDL objects used by the player:

| Object          | Role                                                                 | Created with                 | Destroyed with        |
| --------------- | -------------------------------------------------------------------- | ---------------------------- | --------------------- |
| video subsystem | Connects SDL to the window system and the displays.                  | `SDL_Init(SDL_INIT_VIDEO)`   | `SDL_Quit`            |
| `SDL_Window`    | A window of the operating system.                                    | `SDL_CreateWindow`           | `SDL_DestroyWindow`   |
| `SDL_Renderer`  | A 2D drawing context attached to a window.                           | `SDL_CreateRenderer`         | `SDL_DestroyRenderer` |
| `SDL_Texture`   | An image that belongs to a renderer.                                 | `SDL_CreateTexture`          | `SDL_DestroyTexture`  |
| `SDL_Event`     | A notification from the system: window closed, resized, key pressed. | filled in by `SDL_PollEvent` | not applicable        |

The **renderer** is the central piece. It is a simple 2D drawing API: clear the window, draw a texture, present the result. Behind it SDL uses whatever backend suits the platform (Direct3D, Metal, Vulkan, OpenGL, or a software fallback when nothing else is available), so the same calls work everywhere, and the heavy lifting normally happens on the GPU.

## 2. From a decoded frame to pixels on the screen

### The path of a frame

```text
 AVFrame                      SDL_Texture                 window
 (CPU memory,                 (owned by the renderer,     (back buffer, then
  planar YUV 4:2:0)            same pixel layout)          the screen)

   data[0..2] ── SDL_UpdateYUVTexture ──▶ texture ── SDL_RenderTexture ──▶ back buffer
                                                                                │
                                                                      SDL_RenderPresent
                                                                                ▼
                                                                             display
```

Three steps happen for every frame that is due: the planes of the `AVFrame` are copied into a texture, the texture is drawn into the window's back buffer, and the back buffer is presented to the display.

### Why a YUV texture

The decoder from Lesson 5 produces `yuv420p` frames: the picture is split into three separate planes. `Y` holds brightness at full resolution, while `U` and `V` hold colour at a quarter of the resolution (half the width, half the height). This is by far the most common output format of video decoders for ordinary files.

For a 1920x1080 frame:

| Plane     | Resolution  | Bytes         |
| --------- | ----------- | ------------- |
| Y         | 1920 x 1080 | 2,073,600     |
| U         | 960 x 540   | 518,400       |
| V         | 960 x 540   | 518,400       |
| **Total** |             | **3,110,400** |

An RGBA image of the same size takes 8,294,400 bytes, more than 2.5 times as much. Converting every frame to RGB on the CPU would cost both time and memory bandwidth.

SDL avoids that conversion. Its pixel format `SDL_PIXELFORMAT_IYUV` (also known as I420) is exactly the planar Y, U, V layout of `AV_PIX_FMT_YUV420P`, and `SDL_UpdateYUVTexture()` accepts the three planes directly. The YUV to RGB conversion happens when the texture is drawn, normally on the GPU.

### Pitch is not width

The rows of a decoded frame can be padded for alignment, so the distance in bytes between two rows (`linesize[i]`, called _pitch_ in SDL) may be larger than the width of the plane. `SDL_UpdateYUVTexture()` takes one pitch per plane, and the `linesize` values from the frame are passed straight through. Using the width instead produces a skewed picture.

### Streaming textures

A texture is created with an access pattern. `SDL_TEXTUREACCESS_STREAMING` marks textures whose contents change often and are written by the CPU, which is exactly the situation of a video: one new image for every frame.

### Colour conversion defaults

SDL picks a default YUV to RGB conversion for YUV textures. For exact colour fidelity, the colour metadata of the stream (matrix coefficients and range) would have to be passed to the texture. This example relies on the defaults.

## 3. Time: when is a frame due?

A decoder delivers frames as fast as the CPU allows, often far faster than real time. Showing them immediately would play a movie at ten times the speed. The player therefore holds every frame until its presentation time.

### Frame time against a wall clock

Each frame carries a `pts` in the units of the stream's time base (Lesson 4). Multiplying the two gives the position of the frame inside the video. The player compares that position with a clock that starts when the first frame is decoded:

```text
 due time of a frame  =  (pts - first_pts) * time_base
 elapsed time         =  now - playback start
 frame is shown when  elapsed >= due time
```

Three details matter:

- **The clock is monotonic.** `SDL_GetTicksNS()` returns nanoseconds since SDL was initialized and never jumps backwards when the system time is adjusted.
- **The conversion is done in integers.** `av_rescale_q()` converts a timestamp from one time base to another using 64-bit integer arithmetic with correct rounding. Converting to a `double` and back accumulates rounding error. A time base is the duration of one tick written as a fraction of a second: `{1, 24}` means one tick lasts 1/24 s, and `{1, 1'000'000'000}` means one tick lasts one billionth of a second, that is one nanosecond (one second contains 1,000,000,000 ns, and the `'` characters are C++ digit separators that keep the literal readable). This target time base matches the unit of `SDL_GetTicksNS()`, so the converted values can be compared directly with the clock. For the frame with `pts` 48 and a time base of 1/24, the due time is `48 * 1/24` s = 2 s, and `av_rescale_q(48, {1, 24}, {1, 1'000'000'000})` returns 2,000,000,000 ns (`48 * (1 / 24) * 10^9 = 2 * 10^9 ns`).

- **The first `pts` is the origin.** A stream does not have to start at timestamp 0 (MP4 files with edit lists often do not), so every timestamp is taken relative to the first decoded frame.

### One frame in hand

The player keeps a single decoded frame "in hand" until it is due. While a frame is pending, nothing else is decoded. As soon as it has been uploaded to the texture, the next frame is decoded and becomes the pending one. This works because the decoder reuses its frame buffer: the pointer returned by `NextFrame()` is valid only until the next call.

### Vsync and the main loop

A display refreshes at a fixed rate, typically 60 times per second. With vsync enabled, `SDL_RenderPresent()` blocks until the next refresh, so the main loop runs once per refresh instead of spinning at full speed and burning a CPU core. A frame that becomes due is picked up at the start of the next loop iteration and shown at the following refresh, so presentation is accurate to within a refresh interval or two (roughly 17 to 33 ms at 60 Hz).

Video rates rarely divide the refresh rate evenly. A 24 fps video on a 60 Hz display needs 2.5 refreshes per frame, so frames alternate between being on screen for two and for three refreshes. This uneven cadence is inherent in presenting 24 fps on a 60 Hz display and is not a defect of the player.

## 4. Program structure

The player is split by responsibility, and only one class knows about both libraries:

| File               | Class                        | Responsibility                                                                                                                     |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `app.h`            | `Application`                | Initializes and shuts down SDL, owns the window and the player, runs the main loop.                                                |
| `sdl_window.h`     | `SdlWindow`                  | Owns the `SDL_Window` and the `SDL_Renderer`; draws a texture into the window. No FFmpeg.                                          |
| `video_player.h`   | `VideoPlayer`                | Decides which frame is on screen at which moment; owns the decoder and the texture. The only class that knows both FFmpeg and SDL. |
| `video_decoder.h`  | `VideoDecoder`               | The decoding code of Lesson 5, reshaped into a pull-style interface. No SDL.                                                       |
| `ffmpeg_handles.h` | `Deleter`, `Handle`, aliases | RAII handles for FFmpeg objects (Lesson 5).                                                                                        |
| `sdl_texture.h`    | `SdlTexture`                 | RAII handle for `SDL_Texture`.                                                                                                     |

Ownership forms a tree:

```text
Application
├── SdlWindow               SDL_Window + SDL_Renderer
└── VideoPlayer
    ├── VideoDecoder        FormatContext, CodecContext, Packet, Frame
    └── SdlTexture          SDL_Texture, created by the window's renderer
```

### Destruction order

Order matters in two places.

**The texture must be destroyed before the renderer.** A texture belongs to the renderer that created it, and `SDL_DestroyRenderer()` frees every texture of that renderer. Destroying the texture afterwards would be a use-after-free.

**`SDL_Quit()` must run after the window is gone.** Members of a class are destroyed _after_ the body of its destructor. A destructor consisting of `SDL_Quit();` would therefore shut SDL down while the `SdlWindow` member still exists, and the window and renderer would be destroyed against a library that is already gone.

Both problems are solved by one explicit teardown function, called from the destructor and from the failure path of the constructor:

```cpp
void Shutdown() noexcept {
    player.reset();
    window.reset();
    SDL_Quit();
}
```

The player goes first (texture, then decoder), then the window (renderer, then window), then SDL itself. The two members are `std::optional` objects because neither can be constructed before `SDL_Init()` has run, and `reset()` makes the order of destruction explicit.

## 5. Walking through the code

The fragments below follow the order of execution.

### `main`

```cpp
int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Usage: " << argv[0] << " <video file>" << std::endl;
        return 1;
    }

    try {
        Application application{argv[1]};
        application.Run();
    } catch (const std::exception& ex) {
        std::cerr << ex.what() << std::endl;
        return 1;
    }
}
```

Every failure in the player, from a missing file to an unsupported pixel format, is reported by throwing `std::runtime_error`. The `Application` object cleans up after itself while the exception propagates, and `main` prints the message and returns a non-zero exit code. This replaces the `return 1` after every call from Lesson 5: the RAII handles make early returns unnecessary, and exceptions make error paths short.

### `SDL_Init`

```cpp
if (!SDL_Init(SDL_INIT_VIDEO)) {
    SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_Init failed: %s", SDL_GetError());
    throw std::runtime_error{SDL_GetError()};
}
```

Initializes the video subsystem, the part of SDL that talks to the window system and the displays. Only video is needed, so audio and the other subsystems stay off. Note the SDL3 convention: the function returns `true` on success.

The remaining constructor code creates the objects in dependency order inside a `try` block:

```cpp
try {
    window.emplace("FFmpeg tutorial", SDL_WINDOW_RESIZABLE);
    player.emplace(videoPath, window.value().Renderer());
    window.value().SetLogicalSize(player.value().Width(), player.value().Height());
} catch (...) {
    Shutdown();
    throw;
}
```

The window comes first, the player needs the window's renderer to create its texture, and the logical size needs the player to report the video resolution. If any step throws, a constructor that has failed never runs its destructor, so `Shutdown()` releases whatever already exists before the exception continues.

### `SDL_CreateWindow`

```cpp
window = SDL_CreateWindow(title, kWindowWidth, kWindowHeight, flags);
if (!window) {
    SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_CreateWindow failed: %s", SDL_GetError());
    throw std::runtime_error{SDL_GetError()};
}
```

Creates a 1440x810 window. `SDL_WINDOW_RESIZABLE` lets the user resize it, which makes the next steps more interesting: the picture has to follow.

### `SDL_CreateRenderer`

```cpp
renderer = SDL_CreateRenderer(window, nullptr);
if (!renderer) {
    SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_CreateRenderer failed: %s", SDL_GetError());
    SDL_DestroyWindow(window);
    throw std::runtime_error{SDL_GetError()};
}
```

Creates the 2D drawing context of the window. The second argument is the name of a backend, and `nullptr` lets SDL choose the best one for the platform. A constructor that throws does not run its own destructor, so the window created a few lines earlier has to be destroyed by hand on this path.

### `SDL_SetRenderVSync`

```cpp
// Presenting waits for the display refresh, which paces the main loop.
if (!SDL_SetRenderVSync(renderer, 1)) {
    SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "SDL_SetRenderVSync failed: %s", SDL_GetError());
}
```

Turns vsync on, so that `SDL_RenderPresent()` waits for the display refresh. A failure is only a warning: some drivers do not support it, and playback still works, though the loop then runs without a brake.

### `VideoDecoder`: the setup from Lesson 5

```cpp
explicit VideoDecoder(const char* path) {
    Check(avformat_open_input(std::out_ptr(format), path, nullptr, nullptr),
          "avformat_open_input");
    Check(avformat_find_stream_info(format.get(), nullptr), "avformat_find_stream_info");

    for (unsigned i = 0; i < format->nb_streams; ++i) {
        if (format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            videoIndex = static_cast<int>(i);
            break;
        }
    }
    if (videoIndex < 0) {
        throw std::runtime_error{"No video stream found"};
    }
    const AVStream* stream = format->streams[videoIndex];
    timeBase = stream->time_base;

    const AVCodec* decoder = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!decoder) {
        throw std::runtime_error{std::format("No decoder found for codec '{}'",
                                             avcodec_get_name(stream->codecpar->codec_id))};
    }

    codec.reset(avcodec_alloc_context3(decoder));
    if (!codec) {
        throw std::runtime_error{"avcodec_alloc_context3 failed"};
    }
    Check(avcodec_parameters_to_context(codec.get(), stream->codecpar),
          "avcodec_parameters_to_context");
    Check(avcodec_open2(codec.get(), decoder, nullptr), "avcodec_open2");

    packet.reset(av_packet_alloc());
    frame.reset(av_frame_alloc());
    if (!packet || !frame) {
        throw std::runtime_error{"Failed to allocate packet or frame"};
    }
}
```

These are the same calls in the same order as in Lesson 5, from `avformat_open_input` to `avcodec_open2`, with the same RAII handles and `std::out_ptr`. Three things changed:

- The objects are now members of a class instead of locals of `run()`.
- Instead of printing a message and returning 1 after each call, a small helper turns any negative FFmpeg return code into an exception.
- The stream's `time_base` is saved, because the player needs it to turn timestamps into seconds.

The error helper:

```cpp
static void Check(int ret, const char* what) {
    if (ret < 0) {
        throw std::runtime_error{std::format("{} failed: {}", what, error_string(ret))};
    }
}
```

The public accessors report what the player needs to know about the stream:

```cpp
int Width() const {
    return codec->width;
}

int Height() const {
    return codec->height;
}

AVPixelFormat PixelFormat() const {
    return codec->pix_fmt;
}

// Unit of the timestamps carried by the decoded frames.
AVRational TimeBase() const {
    return timeBase;
}
```

### `avcodec_receive_frame`: a pull-style `NextFrame`

```cpp
// The returned frame stays valid until the next call to NextFrame().
const AVFrame* NextFrame() {
    while (true) {
        const int ret = avcodec_receive_frame(codec.get(), frame.get());
        if (ret == 0) {
            return frame.get();
        }
        if (ret == AVERROR_EOF) {
            return nullptr;
        }
        if (ret != AVERROR(EAGAIN)) {
            Check(ret, "avcodec_receive_frame");
        }

        // EAGAIN: the decoder wants more input.
        FeedDecoder();
    }
}
```

Lesson 5 _pushed_ packets into the decoder in a loop and printed frames as they came out. A player needs the opposite control flow: the main loop asks for _one_ frame when it is ready to handle one. `NextFrame()` hides the send/receive protocol behind that question:

- `0` means a frame is ready and is returned.
- `AVERROR_EOF` means the decoder is fully drained, so the video is over and `nullptr` is returned.
- `EAGAIN` means the decoder needs more input. `FeedDecoder()` provides it and the loop asks again.
- Any other error is thrown.

The same rules as before apply: the returned frame belongs to the decoder, and `avcodec_receive_frame()` unreferences it before filling it again, which is why it is valid only until the next call.

### `av_read_frame` and `avcodec_send_packet`: `FeedDecoder`

```cpp
// Sends the next video packet to the decoder. At the end of the file a null
// packet is sent instead, which switches the decoder to draining mode.
void FeedDecoder() {
    while (true) {
        int ret = av_read_frame(format.get(), packet.get());
        if (ret == AVERROR_EOF) {
            Check(avcodec_send_packet(codec.get(), nullptr), "avcodec_send_packet (flush)");
            return;
        }
        Check(ret, "av_read_frame");

        if (packet->stream_index != videoIndex) {
            av_packet_unref(packet.get());
            continue;
        }

        ret = avcodec_send_packet(codec.get(), packet.get());
        av_packet_unref(packet.get());
        Check(ret, "avcodec_send_packet");
        return;
    }
}
```

This is the demux half of Lesson 5's loop. It reads packets until one belongs to the video stream, sends it to the decoder, releases it and returns. Packets of other streams (audio, in a typical file) are skipped. At the end of the file, the `nullptr` packet switches the decoder to draining mode, and the next calls to `avcodec_receive_frame()` return the buffered frames and finally `AVERROR_EOF`. The drain stage of Lesson 5 is thus folded into the same two functions.

### `SDL_CreateTexture`

```cpp
VideoPlayer(const char* path, SDL_Renderer* renderer) : decoder(path) {
    if (decoder.PixelFormat() != AV_PIX_FMT_YUV420P) {
        const char* name = av_get_pix_fmt_name(decoder.PixelFormat());
        throw std::runtime_error{
            std::format("Unsupported pixel format: {}", name ? name : "unknown")};
    }

    // IYUV is SDL's name for planar YUV 4:2:0 (Y, U, V planes), the same
    // layout as AV_PIX_FMT_YUV420P, so decoded frames need no conversion.
    texture.reset(SDL_CreateTexture(renderer, SDL_PIXELFORMAT_IYUV,
                                    SDL_TEXTUREACCESS_STREAMING, decoder.Width(),
                                    decoder.Height()));
    if (!texture) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_CreateTexture failed: %s",
                     SDL_GetError());
        throw std::runtime_error{SDL_GetError()};
    }
}
```

The decoder is created first, so the video resolution and pixel format are known. The pixel format is checked before anything else, because the whole upload path depends on it: only `yuv420p` maps directly onto an SDL texture. Other formats (4:4:4, 10-bit, the full-range `yuvj` variants) end in a readable error instead of a garbled picture.

The texture is created with the video's width and height, the `IYUV` format and the streaming access pattern from section 2. It is owned by a `SdlTexture`, an alias of `std::unique_ptr` with a deleter that calls `SDL_DestroyTexture`:

```cpp
struct SdlTextureDeleter {
    void operator()(SDL_Texture* texture) const noexcept {
        SDL_DestroyTexture(texture);
    }
};

using SdlTexture = std::unique_ptr<SDL_Texture, SdlTextureDeleter>;
```

Unlike FFmpeg's free functions, `SDL_DestroyTexture` takes a plain pointer, so it needs its own small deleter instead of the `Deleter<auto Free>` template.

### `SDL_SetRenderLogicalPresentation`

```cpp
// Everything is drawn in a width x height coordinate space that SDL scales to
// the window, keeping the aspect ratio and filling the rest with black bars.
void SetLogicalSize(int width, int height) {
    if (!SDL_SetRenderLogicalPresentation(renderer, width, height,
                                          SDL_LOGICAL_PRESENTATION_LETTERBOX)) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_SetRenderLogicalPresentation failed: %s",
                     SDL_GetError());
        throw std::runtime_error{SDL_GetError()};
    }
}
```

Tells the renderer that the drawing area is as large as the video. SDL then scales that area to the actual window size automatically and, in `LETTERBOX` mode, preserves the aspect ratio by leaving bars at the sides or at the top and bottom. A 4:3 video in a 16:9 window gets bars left and right, and resizing the window needs no code at all. Without this call the texture would be stretched over the whole window and distorted whenever the window's aspect ratio differs from the video's.

### `SDL_PollEvent`: the main loop

```cpp
void Run() {
    bool running = true;
    while (running) {
        SDL_Event event{};
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) {
                running = false;
            }
        }

        player.value().Update();
        window.value().Show(player.value().Texture());
    }
}
```

Every iteration does three things, in this order:

1. **Drain the event queue.** `SDL_PollEvent()` returns pending events one at a time. `SDL_EVENT_QUIT` arrives when the last window is closed (and when the process receives SIGINT or SIGTERM), and it ends the loop. Without polling, the window system would typically report the application as not responding.
2. **Advance playback.** `Update()` uploads the next frame if its time has come.
3. **Draw.** `Show()` redraws the window. With vsync this call blocks until the next refresh and sets the pace of the loop.

### `SDL_GetTicksNS`: `Update`

```cpp
// Call once per iteration of the main loop. Uploads the next frame to the
// texture as soon as its presentation time has been reached.
void Update() {
    if (!pending) {
        if (finished) {
            return;
        }

        pending = decoder.NextFrame();
        if (!pending) {
            finished = true;
            SDL_Log("End of stream");
            return;
        }

        if (!started) {
            started = true;
            const std::int64_t pts = Pts(*pending);
            firstPts = pts != AV_NOPTS_VALUE ? pts : 0;
            startTimeNs = SDL_GetTicksNS();
        }
    }

    if (SDL_GetTicksNS() - startTimeNs < DueTimeNs(*pending)) {
        return;
    }

    Upload(*pending);
    pending = nullptr;
}
```

`pending` is the frame in hand. The logic reads top to bottom:

- With no pending frame and the video not finished, the next frame is pulled from the decoder. If there is none, the video is over: playback is marked as finished and the last frame stays on screen.
- The first frame defines the clock: its `pts` becomes the origin and `SDL_GetTicksNS()` the moment playback starts.
- If the elapsed time is still smaller than the due time of the pending frame, the function returns and the frame waits for a later iteration.
- Otherwise the frame is uploaded and released, so the next call decodes the next one.

Decoding happens at most once per iteration and only right after an upload, so the decoder never runs ahead of the clock by more than one frame.

### `av_rescale_q`: `DueTimeNs`

```cpp
static std::int64_t Pts(const AVFrame& frame) {
    return frame.pts != AV_NOPTS_VALUE ? frame.pts : frame.best_effort_timestamp;
}

// Time since the start of playback at which the frame should appear.
std::uint64_t DueTimeNs(const AVFrame& frame) const {
    const std::int64_t pts = Pts(frame);
    if (pts == AV_NOPTS_VALUE) {
        return 0;
    }

    const std::int64_t offset = std::max<std::int64_t>(pts - firstPts, 0);
    return static_cast<std::uint64_t>(
        av_rescale_q(offset, decoder.TimeBase(), kNanosecondTimeBase));
}
```

`Pts()` is the same fallback as in Lesson 5: `pts` when set, `best_effort_timestamp` otherwise. `DueTimeNs()` subtracts the first `pts` and rescales the result from the stream's time base to nanoseconds with `av_rescale_q()`. The nanosecond time base is a constant of the class:

```cpp
static constexpr AVRational kNanosecondTimeBase{1, 1'000'000'000};
```

A frame without any timestamp is due immediately (0), and a negative offset, which can occur in streams that start with pre-roll, is clamped to zero.

### `SDL_UpdateYUVTexture`: `Upload`

```cpp
void Upload(const AVFrame& frame) {
    if (!SDL_UpdateYUVTexture(texture.get(), nullptr, frame.data[0], frame.linesize[0],
                              frame.data[1], frame.linesize[1], frame.data[2],
                              frame.linesize[2])) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_UpdateYUVTexture failed: %s",
                     SDL_GetError());
        throw std::runtime_error{SDL_GetError()};
    }
    hasFrame = true;
}
```

Copies the three planes of the frame into the texture. The `nullptr` rectangle means "the whole texture", and each plane comes with its own pitch (`linesize`). After the first successful upload, `hasFrame` becomes true, which is what makes the texture visible to the window:

```cpp
// Texture with the most recent frame, or nullptr before the first one.
SDL_Texture* Texture() const {
    return hasFrame ? texture.get() : nullptr;
}
```

Before the first upload a streaming texture has undefined contents, so the player hands out `nullptr` instead and the window simply stays black.

### `SDL_RenderClear`, `SDL_RenderTexture` and `SDL_RenderPresent`: `Show`

```cpp
void Show(SDL_Texture* texture) {
    SDL_SetRenderDrawColor(renderer, 0x00, 0x00, 0x00, 0xFF);
    SDL_RenderClear(renderer);
    if (texture) {
        SDL_RenderTexture(renderer, texture, nullptr, nullptr);
    }
    SDL_RenderPresent(renderer);
}
```

A frame of drawing consists of the same three steps every time:

- `SDL_SetRenderDrawColor()` and `SDL_RenderClear()` fill the whole target with opaque black. This is also the colour of the letterbox bars.
- `SDL_RenderTexture()` draws the texture. Both rectangles are `nullptr`: the whole texture is the source, and the whole logical drawing area is the destination, which the logical presentation then scales into the window.
- `SDL_RenderPresent()` swaps the finished image onto the display and, with vsync, waits for the refresh.

The window is redrawn on every iteration even when the texture has not changed. This keeps resizing and uncovering the window correct without any special handling, and the cost is a single textured quad per refresh.

### `SDL_DestroyRenderer` and `SDL_DestroyWindow`: teardown

```cpp
~SdlWindow() {
    Destroy();
}

void Destroy() noexcept {
    if (renderer) {
        SDL_DestroyRenderer(renderer);
    }
    if (window) {
        SDL_DestroyWindow(window);
    }
}
```

The renderer is destroyed before the window it is attached to. Together with `Application::Shutdown()` from section 4, the complete teardown order is: texture and decoder (`player.reset()`), renderer and window (`window.reset()`), SDL (`SDL_Quit()`). Move construction and move assignment of `SdlWindow` use `std::exchange` to leave the source empty, so a moved-from window destroys nothing.

## 6. Running the player

```bash
./lesson-6 big_buck_bunny_1080p_stereo.avi
```

- A 1440x810 window opens and the video plays at its natural speed. The first frame appears immediately, because it is due at time zero.
- A resizable window keeps the aspect ratio of the video, with black bars where needed.
- When the last frame has been shown, `End of stream` is logged and the final picture stays on screen until the window is closed.
- Closing the window ends the loop, and `Shutdown()` releases everything in the order described above.

The usage message and a readable error appear for a missing argument, a file that cannot be opened, a file without a video stream, and a pixel format other than `yuv420p`.

## 7. Scope and limitations

The player is deliberately small. Its limits:

- **No audio.** There is no second stream to keep in step, so the wall clock is the only clock. Playback speed is correct, but there is nothing to synchronize with.
- **No frame dropping.** If decoding or presenting falls behind, the overdue frames are shown one per iteration instead of being skipped. On a machine that decodes faster than real time this never matters, and the player simply catches up.
- **Decoding on the UI thread.** The main loop decodes, uploads and draws sequentially. A very slow decoder stalls event handling, because both live in the same loop.
- **Only `yuv420p`.** Any other pixel format needs a conversion step that the example does not include.
- **No pause or seeking.** The clock only runs forward from the first frame.
- **Default colour conversion.** The colour matrix and range of the stream are not read.

## 8. Common pitfalls

- **Checking SDL3 results the SDL2 way.** In SDL2 most functions returned `0` on success and a negative value on failure, so code like `if (SDL_Init(SDL_INIT_VIDEO) < 0)` was common. In SDL3 they return `bool`, and such a check never fires because `false` converts to `0`. Failures pass silently.
- **Using the width as the pitch.** `SDL_UpdateYUVTexture()` needs the `linesize` of every plane, which can exceed the plane's width.
- **Destroying a texture after its renderer.** The renderer frees its textures, so a texture that outlives it is a dangling pointer.
- **Calling `SDL_Quit()` too early.** A destructor body runs before the members are destroyed, so SDL objects held as members outlive an `SDL_Quit()` placed there.
- **Keeping the decoder's frame across a `NextFrame()` call.** The frame buffer is reused, so the pointer is valid only until the next call. This is why the player uploads the pending frame before decoding the next one.
- **Running without vsync or any delay.** The loop then spins at full speed and uses a full CPU core.
- **Assuming the stream starts at timestamp 0.** The first `pts` is the origin of the clock.

## Build and run

The lesson's target is added to the repository's CMake build:

```cmake
add_executable(lesson-6
    main.cpp
)

target_link_libraries(lesson-6 PRIVATE
    tutorial_dependencies
)
```

All of the code is in headers included from `main.cpp`, so the target needs a single source file, and linking goes through the repository's shared `tutorial_dependencies` target. As in Lesson 5, a compiler with `std::out_ptr` is required (GCC 14 or newer with libstdc++).

## Complete program

### `ffmpeg_handles.h`

```cpp
// ffmpeg_handles.h
#pragma once

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
template <auto Free>
struct Deleter {
    template <typename T>
    void operator()(T* ptr) const noexcept {
        Free(&ptr);
    }
};

template <typename T, auto Free>
using Handle = std::unique_ptr<T, Deleter<Free>>;

using FormatContext = Handle<AVFormatContext, avformat_close_input>;
using CodecContext = Handle<AVCodecContext, avcodec_free_context>;
using Packet = Handle<AVPacket, av_packet_free>;
using Frame = Handle<AVFrame, av_frame_free>;

inline std::string error_string(int error) {
    char buffer[AV_ERROR_MAX_STRING_SIZE] = {};
    av_strerror(error, buffer, sizeof(buffer));
    return buffer;
}
```

### `sdl_texture.h`

```cpp
// sdl_texture.h
#pragma once

#include <memory>

#include <SDL3/SDL.h>

struct SdlTextureDeleter {
    void operator()(SDL_Texture* texture) const noexcept {
        SDL_DestroyTexture(texture);
    }
};

// A texture belongs to the renderer that created it, so it has to be destroyed
// before that renderer is.
using SdlTexture = std::unique_ptr<SDL_Texture, SdlTextureDeleter>;
```

### `video_decoder.h`

```cpp
// video_decoder.h
#pragma once

#include <format>
#include <memory>
#include <stdexcept>

#include "ffmpeg_handles.h"

// Pull-based video decoder: every NextFrame() call returns the next decoded
// frame in presentation order, or nullptr once the whole file has been decoded.
class VideoDecoder {
   public:
    explicit VideoDecoder(const char* path) {
        Check(avformat_open_input(std::out_ptr(format), path, nullptr, nullptr),
              "avformat_open_input");
        Check(avformat_find_stream_info(format.get(), nullptr), "avformat_find_stream_info");

        for (unsigned i = 0; i < format->nb_streams; ++i) {
            if (format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
                videoIndex = static_cast<int>(i);
                break;
            }
        }
        if (videoIndex < 0) {
            throw std::runtime_error{"No video stream found"};
        }
        const AVStream* stream = format->streams[videoIndex];
        timeBase = stream->time_base;

        const AVCodec* decoder = avcodec_find_decoder(stream->codecpar->codec_id);
        if (!decoder) {
            throw std::runtime_error{std::format("No decoder found for codec '{}'",
                                                 avcodec_get_name(stream->codecpar->codec_id))};
        }

        codec.reset(avcodec_alloc_context3(decoder));
        if (!codec) {
            throw std::runtime_error{"avcodec_alloc_context3 failed"};
        }
        Check(avcodec_parameters_to_context(codec.get(), stream->codecpar),
              "avcodec_parameters_to_context");
        Check(avcodec_open2(codec.get(), decoder, nullptr), "avcodec_open2");

        packet.reset(av_packet_alloc());
        frame.reset(av_frame_alloc());
        if (!packet || !frame) {
            throw std::runtime_error{"Failed to allocate packet or frame"};
        }
    }

    int Width() const {
        return codec->width;
    }

    int Height() const {
        return codec->height;
    }

    AVPixelFormat PixelFormat() const {
        return codec->pix_fmt;
    }

    // Unit of the timestamps carried by the decoded frames.
    AVRational TimeBase() const {
        return timeBase;
    }

    // The returned frame stays valid until the next call to NextFrame().
    const AVFrame* NextFrame() {
        while (true) {
            const int ret = avcodec_receive_frame(codec.get(), frame.get());
            if (ret == 0) {
                return frame.get();
            }
            if (ret == AVERROR_EOF) {
                return nullptr;
            }
            if (ret != AVERROR(EAGAIN)) {
                Check(ret, "avcodec_receive_frame");
            }

            // EAGAIN: the decoder wants more input.
            FeedDecoder();
        }
    }

   private:
    static void Check(int ret, const char* what) {
        if (ret < 0) {
            throw std::runtime_error{std::format("{} failed: {}", what, error_string(ret))};
        }
    }

    // Sends the next video packet to the decoder. At the end of the file a null
    // packet is sent instead, which switches the decoder to draining mode.
    void FeedDecoder() {
        while (true) {
            int ret = av_read_frame(format.get(), packet.get());
            if (ret == AVERROR_EOF) {
                Check(avcodec_send_packet(codec.get(), nullptr), "avcodec_send_packet (flush)");
                return;
            }
            Check(ret, "av_read_frame");

            if (packet->stream_index != videoIndex) {
                av_packet_unref(packet.get());
                continue;
            }

            ret = avcodec_send_packet(codec.get(), packet.get());
            av_packet_unref(packet.get());
            Check(ret, "avcodec_send_packet");
            return;
        }
    }

    FormatContext format;
    CodecContext codec;
    Packet packet;
    Frame frame;
    int videoIndex = -1;
    AVRational timeBase{};
};
```

### `video_player.h`

```cpp
// video_player.h
#pragma once

#include <algorithm>
#include <cstdint>
#include <format>
#include <stdexcept>

#include <SDL3/SDL.h>

#include "ffmpeg_handles.h"
#include "sdl_texture.h"
#include "video_decoder.h"

// Decodes a video file and keeps an SDL texture up to date with the frame that
// should be on screen right now, using the frame timestamps and the wall clock.
class VideoPlayer {
    static constexpr AVRational kNanosecondTimeBase{1, 1'000'000'000};

   public:
    VideoPlayer(const char* path, SDL_Renderer* renderer) : decoder(path) {
        if (decoder.PixelFormat() != AV_PIX_FMT_YUV420P) {
            const char* name = av_get_pix_fmt_name(decoder.PixelFormat());
            throw std::runtime_error{
                std::format("Unsupported pixel format: {}", name ? name : "unknown")};
        }

        // IYUV is SDL's name for planar YUV 4:2:0 (Y, U, V planes), the same
        // layout as AV_PIX_FMT_YUV420P, so decoded frames need no conversion.
        texture.reset(SDL_CreateTexture(renderer, SDL_PIXELFORMAT_IYUV,
                                        SDL_TEXTUREACCESS_STREAMING, decoder.Width(),
                                        decoder.Height()));
        if (!texture) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_CreateTexture failed: %s",
                         SDL_GetError());
            throw std::runtime_error{SDL_GetError()};
        }
    }

    int Width() const {
        return decoder.Width();
    }

    int Height() const {
        return decoder.Height();
    }

    // Texture with the most recent frame, or nullptr before the first one.
    SDL_Texture* Texture() const {
        return hasFrame ? texture.get() : nullptr;
    }

    // Call once per iteration of the main loop. Uploads the next frame to the
    // texture as soon as its presentation time has been reached.
    void Update() {
        if (!pending) {
            if (finished) {
                return;
            }

            pending = decoder.NextFrame();
            if (!pending) {
                finished = true;
                SDL_Log("End of stream");
                return;
            }

            if (!started) {
                started = true;
                const std::int64_t pts = Pts(*pending);
                firstPts = pts != AV_NOPTS_VALUE ? pts : 0;
                startTimeNs = SDL_GetTicksNS();
            }
        }

        if (SDL_GetTicksNS() - startTimeNs < DueTimeNs(*pending)) {
            return;
        }

        Upload(*pending);
        pending = nullptr;
    }

   private:
    static std::int64_t Pts(const AVFrame& frame) {
        return frame.pts != AV_NOPTS_VALUE ? frame.pts : frame.best_effort_timestamp;
    }

    // Time since the start of playback at which the frame should appear.
    std::uint64_t DueTimeNs(const AVFrame& frame) const {
        const std::int64_t pts = Pts(frame);
        if (pts == AV_NOPTS_VALUE) {
            return 0;
        }

        const std::int64_t offset = std::max<std::int64_t>(pts - firstPts, 0);
        return static_cast<std::uint64_t>(
            av_rescale_q(offset, decoder.TimeBase(), kNanosecondTimeBase));
    }

    void Upload(const AVFrame& frame) {
        if (!SDL_UpdateYUVTexture(texture.get(), nullptr, frame.data[0], frame.linesize[0],
                                  frame.data[1], frame.linesize[1], frame.data[2],
                                  frame.linesize[2])) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_UpdateYUVTexture failed: %s",
                         SDL_GetError());
            throw std::runtime_error{SDL_GetError()};
        }
        hasFrame = true;
    }

    VideoDecoder decoder;
    SdlTexture texture;

    const AVFrame* pending = nullptr;  // decoded, but not yet due
    bool started = false;
    bool finished = false;
    bool hasFrame = false;
    std::int64_t firstPts = 0;
    std::uint64_t startTimeNs = 0;
};
```

### `sdl_window.h`

```cpp
// sdl_window.h
#pragma once

#include <stdexcept>
#include <utility>

#include <SDL3/SDL.h>

class SdlWindow {
    static constexpr int kWindowWidth = 1440;
    static constexpr int kWindowHeight = 810;

   public:
    SdlWindow(const char* title, SDL_WindowFlags flags) {
        window = SDL_CreateWindow(title, kWindowWidth, kWindowHeight, flags);
        if (!window) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_CreateWindow failed: %s", SDL_GetError());
            throw std::runtime_error{SDL_GetError()};
        }

        renderer = SDL_CreateRenderer(window, nullptr);
        if (!renderer) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_CreateRenderer failed: %s", SDL_GetError());
            SDL_DestroyWindow(window);
            throw std::runtime_error{SDL_GetError()};
        }

        // Presenting waits for the display refresh, which paces the main loop.
        if (!SDL_SetRenderVSync(renderer, 1)) {
            SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "SDL_SetRenderVSync failed: %s", SDL_GetError());
        }
    }

    SdlWindow(const SdlWindow&) = delete;
    SdlWindow& operator=(const SdlWindow&) = delete;

    SdlWindow(SdlWindow&& other) noexcept
        : window(std::exchange(other.window, nullptr)),
          renderer(std::exchange(other.renderer, nullptr)) {}

    SdlWindow& operator=(SdlWindow&& other) noexcept {
        if (this != &other) {
            Destroy();
            window = std::exchange(other.window, nullptr);
            renderer = std::exchange(other.renderer, nullptr);
        }
        return *this;
    }

    ~SdlWindow() {
        Destroy();
    }

    SDL_Renderer* Renderer() const {
        return renderer;
    }

    // Everything is drawn in a width x height coordinate space that SDL scales to
    // the window, keeping the aspect ratio and filling the rest with black bars.
    void SetLogicalSize(int width, int height) {
        if (!SDL_SetRenderLogicalPresentation(renderer, width, height,
                                              SDL_LOGICAL_PRESENTATION_LETTERBOX)) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_SetRenderLogicalPresentation failed: %s",
                         SDL_GetError());
            throw std::runtime_error{SDL_GetError()};
        }
    }

    void Show(SDL_Texture* texture) {
        SDL_SetRenderDrawColor(renderer, 0x00, 0x00, 0x00, 0xFF);
        SDL_RenderClear(renderer);
        if (texture) {
            SDL_RenderTexture(renderer, texture, nullptr, nullptr);
        }
        SDL_RenderPresent(renderer);
    }

   private:
    void Destroy() noexcept {
        if (renderer) {
            SDL_DestroyRenderer(renderer);
        }
        if (window) {
            SDL_DestroyWindow(window);
        }
    }

    SDL_Window* window = nullptr;
    SDL_Renderer* renderer = nullptr;
};
```

### `app.h`

```cpp
// application.h
#pragma once

#include <optional>
#include <stdexcept>

#include <SDL3/SDL.h>

#include "sdl_window.h"
#include "video_player.h"

class Application {
   public:
    explicit Application(const char* videoPath) {
        if (!SDL_Init(SDL_INIT_VIDEO)) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "SDL_Init failed: %s", SDL_GetError());
            throw std::runtime_error{SDL_GetError()};
        }

        try {
            window.emplace("FFmpeg tutorial", SDL_WINDOW_RESIZABLE);
            player.emplace(videoPath, window.value().Renderer());
            window.value().SetLogicalSize(player.value().Width(), player.value().Height());
        } catch (...) {
            Shutdown();
            throw;
        }
    }

    Application(const Application&) = delete;
    Application& operator=(const Application&) = delete;
    Application(Application&&) = delete;
    Application& operator=(Application&&) = delete;

    ~Application() {
        Shutdown();
    }

    void Run() {
        bool running = true;
        while (running) {
            SDL_Event event{};
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) {
                    running = false;
                }
            }

            player.value().Update();
            window.value().Show(player.value().Texture());
        }
    }

   private:
    // Members are destroyed after the destructor body, so everything that has to
    // go before SDL_Quit() is released explicitly: the player's texture belongs to
    // the window's renderer, hence player first, then window, then SDL itself.
    void Shutdown() noexcept {
        player.reset();
        window.reset();
        SDL_Quit();
    }

    std::optional<SdlWindow> window;
    std::optional<VideoPlayer> player;
};
```

### `main.cpp`

```cpp
#include <iostream>

#include "app.h"

int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Usage: " << argv[0] << " <video file>" << std::endl;
        return 1;
    }

    try {
        Application application{argv[1]};
        application.Run();
    } catch (const std::exception& ex) {
        std::cerr << ex.what() << std::endl;
        return 1;
    }
}
```

## Where to find the code

The full set of lessons for this series lives in the companion repository: [https://github.com/m-konarzewski/FFmpeg-tutorial](https://github.com/m-konarzewski/FFmpeg-tutorial). Clone it and build following the instructions in that repo.
