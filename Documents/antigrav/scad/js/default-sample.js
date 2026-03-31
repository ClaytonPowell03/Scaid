export const DEFAULT_FILENAME = 'orbital_gearbox_housing.scad';

export const DEFAULT_SAMPLE_CODE = `// Orbital Gearbox Housing
// A detailed mechanical showcase for the default editor scene.
// Press Ctrl+Enter to render, then orbit the camera to inspect the layers.

$fn = 72;
hex_fn = 6;

flange_r = 16;
flange_h = 2.6;
body_r = 12;
body_h = 14;
cap_r = 13.6;
cap_h = 2.0;
bore_r = 4.2;

bolt_circle = 13.1;
top_bolt_circle = 10.6;
tie_circle = 11.4;
pod_circle = 15.2;

fin_len = 4.6;
fin_w = 0.9;
fin_h = 9.8;
fin_offset = body_r + (fin_len / 2) - 0.35;

body_mid_z = flange_h + (body_h / 2);
cap_z = flange_h + body_h;
tooth_z = cap_z + cap_h;
rotor_z = flange_h + 1.2;
blade_z = flange_h + 7.6;
shaft_h = body_h + cap_h + 5;

// Main shell
color([0.71, 0.75, 0.81])
difference() {
  union() {
    cylinder(h = flange_h, r = flange_r);
    translate([0, 0, flange_h])
      cylinder(h = body_h, r = body_r);
    translate([0, 0, cap_z])
      cylinder(h = cap_h, r = cap_r);
  }

  translate([0, 0, -0.5])
    cylinder(h = flange_h + body_h + cap_h + 1, r = bore_r);

  for (a = [0:45:315])
    rotate([0, 0, a])
      translate([bolt_circle, 0, -0.5])
        cylinder(h = flange_h + 1, r = 0.72);
}

// Retaining ring
color([0.84, 0.87, 0.91])
difference() {
  translate([0, 0, cap_z + 0.15])
    cylinder(h = 1.8, r = 10.6);
  translate([0, 0, cap_z - 0.1])
    cylinder(h = 2.2, r = 8.85);

  for (a = [22.5:45:337.5])
    rotate([0, 0, a])
      translate([top_bolt_circle, 0, cap_z - 0.1])
        cylinder(h = 2.2, r = 0.42);
}

// Cooling fins
color([0.58, 0.63, 0.70])
for (a = [0:30:330])
  rotate([0, 0, a])
    translate([fin_offset, 0, body_mid_z + 0.35])
      cube(size = [fin_len, fin_w, fin_h], center = true);

// Secondary ribs
color([0.64, 0.69, 0.76])
for (a = [15:30:345])
  rotate([0, 0, a])
    translate([body_r + 1.5, 0, body_mid_z - 0.55])
      cube(size = [2.4, 0.8, 7.9], center = true);

// Structural ribs
color([0.62, 0.67, 0.74])
for (a = [0:90:270])
  rotate([0, 0, a])
    translate([body_r - 1.0, 0, body_mid_z])
      cube(size = [2.0, 2.5, body_h - 0.8], center = true);

// Tie rods with collars
color([0.90, 0.92, 0.95])
for (a = [0:45:315])
  rotate([0, 0, a])
    translate([tie_circle, 0, flange_h + 1.2])
      cylinder(h = body_h - 2.4, r = 0.42);

color([0.20, 0.22, 0.26])
for (a = [0:45:315])
  rotate([0, 0, a])
    translate([tie_circle, 0, flange_h + 0.95])
      cylinder(h = 0.82, r = 0.75);

color([0.20, 0.22, 0.26])
for (a = [0:45:315])
  rotate([0, 0, a])
    translate([tie_circle, 0, cap_z - 0.15])
      cylinder(h = 0.82, r = 0.75);

// Flange bolts
color([0.13, 0.14, 0.17])
for (a = [0:45:315])
  rotate([0, 0, a])
    translate([bolt_circle, 0, flange_h])
      cylinder(h = 1.15, r = 1.02, $fn = hex_fn);

// Top cap bolts
color([0.17, 0.18, 0.22])
for (a = [22.5:45:337.5])
  rotate([0, 0, a])
    translate([top_bolt_circle, 0, cap_z + 1.85])
      cylinder(h = 0.85, r = 0.74, $fn = hex_fn);

// Castellated top ring
color([0.77, 0.80, 0.86])
for (a = [0:15:345])
  rotate([0, 0, a])
    translate([cap_r + 0.7, 0, tooth_z])
      cube(size = [1.3, 1.95, 1.45], center = true);

// Service pods
color([0.42, 0.46, 0.52])
for (a = [45:90:315])
  rotate([0, 0, a])
    translate([pod_circle, 0, flange_h + 8.6])
      rotate([0, 90, 0])
        cylinder(h = 4.5, r = 1.5, center = true);

color([0.82, 0.60, 0.22])
for (a = [45:90:315])
  rotate([0, 0, a])
    translate([pod_circle + 2.25, 0, flange_h + 8.6])
      rotate([0, 90, 0])
        cylinder(h = 1.3, r = 0.68, center = true);

// Mounting feet
color([0.69, 0.73, 0.79])
translate([0, 18, 0])
  difference() {
    union() {
      translate([0, 0, 1.1])
        cube(size = [14, 5, 2.2], center = true);
      translate([5.2, 0, 1.1])
        cylinder(h = 2.2, r = 2.5, center = true);
      translate([-5.2, 0, 1.1])
        cylinder(h = 2.2, r = 2.5, center = true);
    }

    translate([5.2, 0, 1.1])
      cylinder(h = 3.0, r = 0.95, center = true);
    translate([-5.2, 0, 1.1])
      cylinder(h = 3.0, r = 0.95, center = true);
  }

color([0.69, 0.73, 0.79])
translate([0, -18, 0])
  difference() {
    union() {
      translate([0, 0, 1.1])
        cube(size = [14, 5, 2.2], center = true);
      translate([5.2, 0, 1.1])
        cylinder(h = 2.2, r = 2.5, center = true);
      translate([-5.2, 0, 1.1])
        cylinder(h = 2.2, r = 2.5, center = true);
    }

    translate([5.2, 0, 1.1])
      cylinder(h = 3.0, r = 0.95, center = true);
    translate([-5.2, 0, 1.1])
      cylinder(h = 3.0, r = 0.95, center = true);
  }

// Foot gussets
color([0.60, 0.64, 0.70])
translate([0, 13.7, 5.0])
  rotate([42, 0, 0])
    cube(size = [10, 1.15, 7.2], center = true);

color([0.60, 0.64, 0.70])
translate([0, -13.7, 5.0])
  rotate([-42, 0, 0])
    cube(size = [10, 1.15, 7.2], center = true);

// Inner shaft
color([0.30, 0.33, 0.38])
cylinder(h = shaft_h, r = 1.38);

// Lower carrier
color([0.46, 0.49, 0.55])
translate([0, 0, rotor_z])
  cylinder(h = 3.0, r = 6.2);

// Carrier spokes
color([0.86, 0.62, 0.18])
for (a = [0:60:300])
  rotate([0, 0, a])
    translate([4.0, 0, rotor_z + 1.5])
      cube(size = [6.1, 1.05, 1.2], center = true);

// Planet rollers
color([0.74, 0.78, 0.84])
for (a = [0:60:300])
  rotate([0, 0, a])
    translate([7.1, 0, rotor_z + 1.45])
      cylinder(h = 2.65, r = 1.02, center = true);

// Inner rotor drum
color([0.22, 0.24, 0.28])
translate([0, 0, rotor_z + 3.0])
  cylinder(h = 6.1, r = 3.6);

// Turbine blades
color([0.32, 0.35, 0.40])
for (a = [0:30:330])
  rotate([0, 0, a])
    translate([5.5, 0, blade_z])
      rotate([0, 0, 22])
        cube(size = [5.0, 0.55, 4.5], center = true);

// Upper cone and bearing cap
color([0.18, 0.20, 0.24])
translate([0, 0, cap_z + 0.75])
  cone(h = 3.6, r1 = 3.6, r2 = 1.2);

color([0.78, 0.81, 0.86])
translate([0, 0, cap_z + 4.35])
  sphere(r = 1.05);

// Sensor collar
color([0.55, 0.58, 0.64])
difference() {
  translate([0, 0, blade_z + 2.75])
    cylinder(h = 1.3, r = 8.5);
  translate([0, 0, blade_z + 2.55])
    cylinder(h = 1.7, r = 7.2);
}
`;
