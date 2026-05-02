import sys
sys.stdout.reconfigure(encoding='utf-8')

path = "C:/Users/harri/Desktop/zenith-macros-beta-1.2-20260402-140416/zenith-macros-beta-1.2/renderer/index.html"

with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

original_len = len(c)

# Check Return key locations
print("Return key locations:")
idx = 0
while True:
    idx = c.find('Return key', idx)
    if idx == -1:
        break
    context = c[max(0,idx-100):idx+100]
    # Find which mc- this is in
    mc_start = c.rfind('id="mc-', 0, idx)
    mc_id = c[mc_start:mc_start+20].split('"')[1] if mc_start != -1 else 'unknown'
    print(f"  in {mc_id}: {c[idx:idx+50]}")
    idx += 1

# kp has Pearl key + Return key - check if Return key is there
idx_kp = c.find('id="mc-kp"')
print("\nmc-kp snippet:", c[idx_kp:idx_kp+700] if idx_kp != -1 else "NOT FOUND")
