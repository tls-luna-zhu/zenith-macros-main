import sys
sys.stdout.reconfigure(encoding='utf-8')

path = "C:/Users/harri/Desktop/zenith-macros-beta-1.2-20260402-140416/zenith-macros-beta-1.2/renderer/index.html"

with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

original_len = len(c)

# Fix mc-ac: change "Activate Key (hold)" to "Keybind (hold)" and add Crystal slot key
# Use a unique part of the ac card context
marker = 'toggleMacroActionGeneric(event, \'ac\', this)"><span>BREAK</span></button>'
idx = c.find(marker)
if idx != -1:
    # find the closing of mc-ac after BREAK button
    rest = c[idx:]
    # pattern to replace
    old_part = '><span>BREAK</span></button></div></div></div><div class="field"><span class="flabel">Activate Key (hold)</span><input class="fi" value="None" readonly onclick="kbOpen(this)"></div><div class="field"><span class="flabel">Delay (ms)</span><input class="fi" type="number" value="25" min="0"></div></div></div>'
    new_part = '><span>BREAK</span></button></div></div></div><div class="field"><span class="flabel">Keybind (hold)</span><input class="fi" value="None" readonly onclick="kbOpen(this)"></div><div class="field"><span class="flabel">Delay (ms)</span><input class="fi" type="number" value="25" min="0"></div><div class="field"><span class="flabel">Crystal slot key</span><input class="fi" value="5" readonly onclick="kbOpen(this)"></div></div></div>'

    if old_part in c:
        c = c.replace(old_part, new_part)
        print("mc-ac fixed: done")
    else:
        print("mc-ac: FAILED - check manually")
        # show what's there
        print("At marker:", c[idx:idx+400])
else:
    print("mc-ac marker not found")

# Check Return key occurrences
print(f"\nReturn key count: {c.count('Return key')}")
# Return key should be in: kp, es (and maybe some other card)
# Check what we have
for keyword in ['Pearl key', 'Return key', 'Elytra slot key']:
    count = c.count(keyword)
    print(f"  '{keyword}' count: {count}")

# Also fix renderHotbar - it's still in the JS
# The renderHotbar function is inside the "HOTBAR RENDERER" block
idx_rh_start = c.find('\n// ─── HOTBAR RENDERER ───\nfunction renderHotbar(')
if idx_rh_start != -1:
    # Find end of function - look for the pattern that ends renderHotbar
    # It ends before the next function
    idx_after = c.find('\n\n// ', idx_rh_start + 50)
    if idx_after != -1:
        removed = c[idx_rh_start:idx_after]
        print(f"\nrenderHotbar block to remove: {len(removed)} chars")
        print(f"  First 100: {removed[:100]}")
        print(f"  Last 100: {removed[-100:]}")
        c = c[:idx_rh_start] + c[idx_after:]
        print("renderHotbar removed: done")
    else:
        print("renderHotbar: end not found")
else:
    print("renderHotbar: start not found")
    idx_rh = c.find('renderHotbar')
    if idx_rh != -1:
        print(f"  renderHotbar found at {idx_rh}: {c[idx_rh-30:idx_rh+100]}")

# Fix renderKeybindsPage reference in resetGamemodeKeys
idx_rkp = c.find('renderKeybindsPage()')
while idx_rkp != -1:
    print(f"\nrenderKeybindsPage() at {idx_rkp}: {c[idx_rkp-100:idx_rkp+100]}")
    idx_rkp = c.find('renderKeybindsPage()', idx_rkp + 1)

# Fix mc-hotbar references
print(f"\nmc-hotbar occurrences: {c.count('mc-hotbar')}")
for keyword in ['mc-hotbar-wrap', 'mc-hotbar']:
    count = c.count(keyword)
    print(f"  '{keyword}' count: {count}")

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f"\nWritten: {len(c)} chars (was {original_len})")
