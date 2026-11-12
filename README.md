# VMS+

A Chrome extension (Manifest V3) that adds a cross-event volunteer dashboard to FIRST's Volunteer Management System (VMS) at `my.firstinspires.org/VMS/`. It covers staffing, shift times, bulk notifications, invite links and QR codes, and FIRST's minimum ages for each role.

Everything runs in your browser on top of your own VMS session. No data leaves your browser except requests to VMS itself and the Gmail drafts you choose to open.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open any VMS page and click the **VMS+** button.

## Files

- `manifest.json`: extension manifest
- `content.js`: the dashboard, injected into VMS pages
- `background.js`: opens Gmail drafts and VMS pages in background tabs
