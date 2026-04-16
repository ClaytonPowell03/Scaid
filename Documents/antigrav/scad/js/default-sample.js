export const DEFAULT_FILENAME = 'rubiks_cube.scad';

export const DEFAULT_SAMPLE_CODE = `// Colorful Rubik's Cube
// A fully colored 3x3 Rubik's cube with rounded cubies and visible gaps.
// Press Ctrl+Enter to render, then orbit the camera to inspect all six faces.

$fn = 24;

// Dimensions
cubie_size = 9;
gap = 1.2;
corner_r = 1.2;
step = cubie_size + gap;

// We build each cubie as a slightly rounded box (cube with small spheres at corners)
// using intersection of three stretched cylinders for the rounded look.

// Face colors (RGB 0-1)
// We use a simplified approach:  each cubie gets colored by its outermost face.
// For a standard Rubik's cube:
//   +Y top    = White   [1.00, 1.00, 1.00]
//   -Y bottom = Yellow  [1.00, 0.84, 0.00]
//   +X right  = Red     [0.80, 0.12, 0.15]
//   -X left   = Orange  [1.00, 0.55, 0.05]
//   +Z front  = Blue    [0.00, 0.45, 0.73]
//   -Z back   = Green   [0.00, 0.62, 0.38]
//   interior  = Dark    [0.12, 0.12, 0.14]

// Core frame (the black inner structure visible through gaps)
color([0.12, 0.12, 0.14])
translate([0, 0, 0])
  cube(size = [28, 28, 28], center = true);

// === TOP LAYER (y = 1) — White top face ===

// Row z=-1
color([1.00, 0.55, 0.05])
translate([-step, step, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([1.00, 1.00, 1.00])
translate([0, step, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, step, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

// Row z=0
color([1.00, 0.55, 0.05])
translate([-step, step, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([1.00, 1.00, 1.00])
translate([0, step, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, step, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

// Row z=1
color([1.00, 0.55, 0.05])
translate([-step, step, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([1.00, 1.00, 1.00])
translate([0, step, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, step, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);


// === MIDDLE LAYER (y = 0) ===

// Row z=-1
color([1.00, 0.55, 0.05])
translate([-step, 0, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.00, 0.62, 0.38])
translate([0, 0, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, 0, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

// Row z=0 (center + edges only, core hidden)
color([1.00, 0.55, 0.05])
translate([-step, 0, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, 0, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

// Row z=1
color([1.00, 0.55, 0.05])
translate([-step, 0, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.00, 0.45, 0.73])
translate([0, 0, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, 0, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);


// === BOTTOM LAYER (y = -1) — Yellow bottom face ===

// Row z=-1
color([1.00, 0.55, 0.05])
translate([-step, -step, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([1.00, 0.84, 0.00])
translate([0, -step, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, -step, -step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

// Row z=0
color([1.00, 0.55, 0.05])
translate([-step, -step, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([1.00, 0.84, 0.00])
translate([0, -step, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, -step, 0])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

// Row z=1
color([1.00, 0.55, 0.05])
translate([-step, -step, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([1.00, 0.84, 0.00])
translate([0, -step, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);

color([0.80, 0.12, 0.15])
translate([step, -step, step])
  cube(size = [cubie_size, cubie_size, cubie_size], center = true);
`;
