#pragma once
// Linux Gamepad Haptics (Dual-Motor Rumble & Steam Deck Force Feedback)
namespace openrash::input {
struct HapticEffect {
    float low_frequency_rumble = 0.0f;  // Motor 1: curb / off-road vibration
    float high_frequency_rumble = 0.0f; // Motor 2: combat impact / crash impulse
    unsigned int duration_ms = 0;
};
}
