# Gamepad & Steam Deck Haptic Rumble Specification

OpenRash provides first-class support for Linux gamepad controllers via modern Linux input subsystem and Web Gamepad API standard.

## Supported Controllers

- **Steam Deck Built-in Controls** (Dual trackpads, analog triggers, L4/L5/R4/R5 grip buttons)
- **Xbox Wireless / Series X|S Controllers**
- **Sony DualShock 4 / DualSense**
- **Nintendo Switch Pro Controller**
- **Generic X-Input / DirectInput Linux Gamepads**

## Rumble Profiles

| Event | Motor 1 (Low Freq / Heavy) | Motor 2 (High Freq / Light) | Duration |
| :--- | :--- | :--- | :--- |
| **Gravel / Off-road shoulder** | 40% intensity | 10% intensity | Continuous |
| **Passing curb strike** | 60% impulse | 20% impulse | 80 ms |
| **Punch / Kick attack** | 20% impulse | 70% sharp impulse | 120 ms |
| **Club / Chain impact** | 80% heavy knock | 90% sharp snap | 180 ms |
| **High-speed motorcycle crash** | 100% full rumble | 100% full rumble | 450 ms |
