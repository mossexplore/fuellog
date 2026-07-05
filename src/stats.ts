// 统计计算（详见需求设计说明书 3.5 节）

export interface FuelRecord {
  id: number;
  refuel_date: string;
  refuel_time: string;
  odometer: number;
  unit_price: number;
  volume: number;
  machine_amount: number;
  paid_amount: number;
  is_full: number;
}

export interface Segment {
  date: string;        // 段末（本次加满）日期
  distance_km: number;
  volume_l: number;
  consumption: number; // 升/百公里
  paid_yuan: number;   // 段内实付合计
  cost_per_km: number; // 元/公里
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// records 必须按 (refuel_date, refuel_time, id) 升序
export function computeStats(records: FuelRecord[]) {
  const n = records.length;
  const totalVolume = records.reduce((s, r) => s + r.volume, 0);
  const totalPaid = records.reduce((s, r) => s + r.paid_amount, 0);
  const totalMachine = records.reduce((s, r) => s + r.machine_amount, 0);
  const totalDistance = n >= 2 ? records[n - 1].odometer - records[0].odometer : 0;

  // 分段油耗：相邻两次加满之间，段耗油 = f_i 之后（不含）至 f_{i+1}（含）的 volume 之和
  const segments: Segment[] = [];
  let segFuelSum = 0;
  let segDistSum = 0;
  const fullIdx = records.map((r, i) => (r.is_full ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k + 1 < fullIdx.length; k++) {
    const a = fullIdx[k], b = fullIdx[k + 1];
    const dist = records[b].odometer - records[a].odometer;
    if (dist <= 0) continue; // 同点重复加油，跳过
    let fuel = 0, paid = 0;
    for (let i = a + 1; i <= b; i++) { fuel += records[i].volume; paid += records[i].paid_amount; }
    segments.push({
      date: records[b].refuel_date,
      distance_km: r2(dist),
      volume_l: r2(fuel),
      consumption: r2((fuel / dist) * 100),
      paid_yuan: r2(paid),
      cost_per_km: r2(paid / dist),
    });
    segFuelSum += fuel;
    segDistSum += dist;
  }

  // 月度油费
  const monthly = new Map<string, number>();
  for (const r of records) {
    const m = r.refuel_date.slice(0, 7);
    monthly.set(m, (monthly.get(m) ?? 0) + r.paid_amount);
  }

  // 月度里程：相邻记录的里程差计入后一条记录所在月份
  const monthlyDist = new Map<string, number>();
  for (let i = 1; i < n; i++) {
    const m = records[i].refuel_date.slice(0, 7);
    monthlyDist.set(m, (monthlyDist.get(m) ?? 0) + (records[i].odometer - records[i - 1].odometer));
  }

  return {
    refuel_count: n,
    total_distance_km: r2(totalDistance),
    total_paid_yuan: r2(totalPaid),
    total_volume_l: r2(totalVolume),
    avg_consumption_l_per_100km: segDistSum > 0 ? r2((segFuelSum / segDistSum) * 100) : null,
    avg_cost_yuan_per_km: totalDistance > 0 ? r2(totalPaid / totalDistance) : null,
    avg_distance_per_refuel_km: n >= 2 ? r2(totalDistance / (n - 1)) : null,
    avg_price_yuan_per_l: totalVolume > 0 ? r2(totalMachine / totalVolume) : null,
    last_segment_consumption: segments.length ? segments[segments.length - 1].consumption : null,
    segments,
    monthly_cost: [...monthly.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, paid]) => ({ month, paid_yuan: r2(paid) })),
    monthly_distance: [...monthlyDist.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, dist]) => ({ month, distance_km: r2(dist) })),
    price_trend: records.map((r) => ({ date: r.refuel_date, price: r.unit_price })),
  };
}
