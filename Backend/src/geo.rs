use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Polygon drawn by the user, as [lon, lat] pairs (GeoJSON order).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[schema(example = json!([[27.70, 45.55], [28.05, 45.55], [28.05, 45.80], [27.70, 45.80]]))]
pub struct Polygon(pub Vec<[f64; 2]>);

impl Polygon {
    pub fn validate(&self, max_km: f64) -> Result<()> {
        if self.0.len() < 3 {
            bail!("polygon needs at least 3 points");
        }
        for [lon, lat] in &self.0 {
            if !(-180.0..=180.0).contains(lon) || !(-90.0..=90.0).contains(lat) {
                bail!("coordinate out of range: [{lon}, {lat}]");
            }
        }
        let (w, h) = self.bbox_km();
        if w > max_km || h > max_km {
            bail!("area too large: {w:.0}x{h:.0} km, max is {max_km:.0} km per side");
        }
        Ok(())
    }

    pub fn bbox(&self) -> [f64; 4] {
        let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for [lon, lat] in &self.0 {
            b[0] = b[0].min(*lon);
            b[1] = b[1].min(*lat);
            b[2] = b[2].max(*lon);
            b[3] = b[3].max(*lat);
        }
        b
    }

    fn bbox_km(&self) -> (f64, f64) {
        let [w, s, e, n] = self.bbox();
        let mid_lat = ((s + n) / 2.0).to_radians();
        ((e - w) * 111.32 * mid_lat.cos(), (n - s) * 110.57)
    }

    /// WKT with the ring closed, as the ASF search API expects.
    pub fn to_wkt(&self) -> String {
        let mut pts: Vec<String> = self.0.iter().map(|[x, y]| format!("{x} {y}")).collect();
        if self.0.first() != self.0.last() {
            pts.push(pts[0].clone());
        }
        format!("POLYGON(({}))", pts.join(","))
    }
}
