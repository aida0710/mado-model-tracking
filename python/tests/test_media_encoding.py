from __future__ import annotations

import io
import struct
import wave
import zlib

import numpy as np
import pytest
from PIL import Image as PilImage

from mado_tracking.errors import ConfigurationError
from mado_tracking.media_encoding import PNG_SIGNATURE, encode_png, encode_wav, sniff_mime_type


def read_wav(content: bytes) -> tuple:
    with wave.open(io.BytesIO(content), "rb") as reader:
        parameters = reader.getparams()
        frames = reader.readframes(parameters.nframes)
    return parameters, np.frombuffer(frames, dtype="<i2")


def png_chunks(content: bytes) -> list[tuple[bytes, bytes, int]]:
    """(type, body, crc) of every chunk after the signature."""
    chunks = []
    offset = len(PNG_SIGNATURE)
    while offset < len(content):
        (length,) = struct.unpack(">I", content[offset : offset + 4])
        chunk_type = content[offset + 4 : offset + 8]
        body = content[offset + 8 : offset + 8 + length]
        (crc,) = struct.unpack(">I", content[offset + 8 + length : offset + 12 + length])
        chunks.append((chunk_type, body, crc))
        offset += 12 + length
    return chunks


def test_a_float_sine_wave_becomes_16_bit_mono_wav_with_its_samples():
    sample_rate = 16000
    time = np.arange(sample_rate // 10) / sample_rate
    sine = 0.5 * np.sin(2 * np.pi * 440 * time)

    encoded = encode_wav(sine, sample_rate=sample_rate)

    parameters, samples = read_wav(encoded.content)
    assert encoded.content[:4] == b"RIFF" and encoded.content[8:12] == b"WAVE"
    assert (parameters.nchannels, parameters.sampwidth, parameters.framerate) == (1, 2, sample_rate)
    assert parameters.nframes == len(sine)
    np.testing.assert_array_equal(samples, np.round(sine * 32767).astype(np.int16))
    assert encoded.mime_type == "audio/wav"
    assert encoded.metadata == {"sampleRate": sample_rate, "channels": 1}


def test_float_samples_outside_minus_one_to_one_are_clipped():
    encoded = encode_wav(np.array([-3.0, -1.0, 0.0, 1.0, 2.5]), sample_rate=8000)

    _parameters, samples = read_wav(encoded.content)
    assert samples.tolist() == [-32767, -32767, 0, 32767, 32767]


def test_int16_stereo_samples_are_written_as_they_are_interleaved():
    stereo = np.array([[1, -1], [1000, -1000], [32767, -32768]], dtype=np.int16)

    encoded = encode_wav(stereo, sample_rate=44100)

    parameters, samples = read_wav(encoded.content)
    assert parameters.nchannels == 2 and parameters.nframes == 3
    assert samples.tolist() == stereo.reshape(-1).tolist()


@pytest.mark.parametrize(
    ("samples", "sample_rate"),
    [
        (np.zeros((2, 16000)), 16000),  # channels first
        (np.zeros(10, dtype=np.int32), 16000),
        (np.zeros(10), 0),
    ],
)
def test_unsupported_audio_arrays_are_refused(samples, sample_rate):
    with pytest.raises(ConfigurationError):
        encode_wav(samples, sample_rate=sample_rate)


def test_an_rgb_array_becomes_a_png_with_valid_ihdr_and_crcs():
    pixels = np.zeros((2, 3, 3), dtype=np.uint8)
    pixels[0, 0] = [255, 0, 0]
    pixels[1, 2] = [0, 0, 255]

    encoded = encode_png(pixels)

    assert encoded.content.startswith(PNG_SIGNATURE)
    chunks = png_chunks(encoded.content)
    assert [chunk_type for chunk_type, _body, _crc in chunks] == [b"IHDR", b"IDAT", b"IEND"]
    for chunk_type, body, crc in chunks:
        assert zlib.crc32(chunk_type + body) == crc
    width, height, depth, color_type, *_rest = struct.unpack(">IIBBBBB", chunks[0][1])
    assert (width, height, depth, color_type) == (3, 2, 8, 2)
    assert encoded.metadata == {"width": 3, "height": 2}
    decoded = np.asarray(PilImage.open(io.BytesIO(encoded.content)))
    np.testing.assert_array_equal(decoded, pixels)


def test_an_rgba_array_keeps_its_alpha_channel():
    pixels = np.array([[[10, 20, 30, 0], [40, 50, 60, 128]]], dtype=np.uint8)

    encoded = encode_png(pixels)

    assert struct.unpack(">IIBBBBB", png_chunks(encoded.content)[0][1])[3] == 6
    decoded = PilImage.open(io.BytesIO(encoded.content))
    assert decoded.mode == "RGBA"
    np.testing.assert_array_equal(np.asarray(decoded), pixels)


def test_a_float_grayscale_array_is_scaled_and_clipped_to_0_255():
    encoded = encode_png(np.array([[-0.5, 0.0, 0.5, 1.0, 2.0]]))

    decoded = PilImage.open(io.BytesIO(encoded.content))
    assert decoded.mode == "L"
    assert np.asarray(decoded).tolist() == [[0, 0, 128, 255, 255]]


@pytest.mark.parametrize(
    "pixels",
    [np.zeros((2, 2, 2), dtype=np.uint8), np.zeros((2, 2), dtype=np.int64), np.zeros((0, 4), dtype=np.uint8)],
)
def test_unsupported_image_arrays_are_refused(pixels):
    with pytest.raises(ConfigurationError):
        encode_png(pixels)


@pytest.mark.parametrize(
    ("head", "mime_type"),
    [
        (b"RIFF\x24\x00\x00\x00WAVEfmt ", "audio/wav"),
        (b"fLaC\x00\x00\x00\x22", "audio/flac"),
        (b"ID3\x04\x00", "audio/mpeg"),
        (b"\xff\xfb\x90\x64", "audio/mpeg"),
        (b"\x00\x00\x00\x20ftypM4A ", "audio/mp4"),
        (b"\x00\x00\x00\x18ftypisom", "video/mp4"),
        (b"\x1a\x45\xdf\xa3\x9f", "video/webm"),
        (PNG_SIGNATURE, "image/png"),
        (b"\xff\xd8\xff\xe0", "image/jpeg"),
        (b"plain text", None),
    ],
)
def test_files_are_recognized_by_their_first_bytes(head, mime_type):
    assert sniff_mime_type(head) == mime_type
