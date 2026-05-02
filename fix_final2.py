import sys
sys.stdout.reconfigure(encoding='utf-8')

path = "C:/Users/harri/Desktop/zenith-macros-beta-1.2-20260402-140416/zenith-macros-beta-1.2/renderer/index.html"

with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

original_len = len(c)

# Fix resetGamemodeKeys: remove renderKeybindsPage() call
old_reset = """function resetGamemodeKeys(gm) {
  _slotKeys[gm] = { ...DEFAULT_SLOT_KEYS[gm] };
  saveSlotKeys();
  renderKeybindsPage();
  syncMacros();
}"""
new_reset = """function resetGamemodeKeys(gm) {
  // Slot key reset (centralized system disabled)
  syncMacros();
}"""
if old_reset in c:
    c = c.replace(old_reset, new_reset)
    print("resetGamemodeKeys: done")
else:
    print("resetGamemodeKeys: FAILED")
    idx = c.find('function resetGamemodeKeys')
    print("  Found at:", idx)
    if idx != -1:
        print("  Snippet:", c[idx:idx+300])

# Verify no more renderKeybindsPage references
remaining = c.count('renderKeybindsPage')
print(f"renderKeybindsPage remaining: {remaining}")

# Check no more renderHotbar references
remaining_rh = c.count('renderHotbar')
print(f"renderHotbar remaining: {remaining_rh}")

# Fix the ss macro config in syncMacros - there was no delay field listed
# but ss does have a delay in the code (let's verify)
idx_ss_cfg = c.find("config.ss = {")
if idx_ss_cfg != -1:
    print("\nconfig.ss:", c[idx_ss_cfg:idx_ss_cfg+400])

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f"\nWritten: {len(c)} chars (was {original_len})")
