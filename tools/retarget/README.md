# Mocap retargeting (walk, run, idle)

Moves the three.js Soldier's motion-captured Mixamo clips (Walk and Run; its Idle is a combat stance and is dropped; `examples/models/gltf/Soldier.glb` in the
three.js repo) onto the six Quaternius bodies in `public/models/people`, and writes `public/models/people/mocap.json`.

How: for every frame, each mapped bone's world rotation is the source bone's rotation change since its rest pose
(the Soldier turned 180 degrees to face +z like ours), applied to the target bone's rest pose after first aligning
the two rest poses bone by bone (Mixamo is a T-pose, Quaternius has the arms down). The hips keep their bob and sway
but not their drift; the Quaternius foot bones hang off the root, so they are put back at the ankles each frame.
Ground speed is measured from the planted foot so the app can play the clips without foot sliding.

    curl -sSL -o Soldier.glb https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/models/gltf/Soldier.glb
    cp ../../public/models/people/*.glb .
    python3 -m http.server 8768 &
    python3 run.py '["(async()=>{const o={};for(const m of [\"man\",\"suit\",\"longsleeve\",\"casual\",\"woman\",\"woman2\"]){o[m]=await retarget(m+\".glb\");}return JSON.stringify(o);})()"]' mocap_all.json

Then round the values to 3 decimals and shift the run's stride by 2 frames so its left foot leads at the same phase
as the walk's. `run.py` drives headless Chrome with Playwright and serves three.js from a local node_modules.
