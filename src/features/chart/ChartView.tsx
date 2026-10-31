import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartArea, ChartColumn, ChartLine, ChartPie, ChartScatter, Download, Plus, X } from "lucide-react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { useT } from "../../i18n";
import type { Cell, ResultSet } from "../../types";
import { Button, Field, IconButton, SectionLabel, Switch, cn } from "../../components/ui";
import { suggestAxes } from "./axes";
import { ColumnSelect } from "./ColumnSelect";

echarts.use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer, SVGRenderer]);

type ChartType = "bar" | "line" | "area" | "pie" | "scatter";
const TYPES: { value: ChartType; icon: ReactNode }[] = [
  { value: "bar", icon: <ChartColumn size={16} aria-hidden="true" /> },
  { value: "line", icon: <ChartLine size={16} aria-hidden="true" /> },
  { value: "area", icon: <ChartArea size={16} aria-hidden="true" /> },
  { value: "pie", icon: <ChartPie size={16} aria-hidden="true" /> },
  { value: "scatter", icon: <ChartScatter size={16} aria-hidden="true" /> },
];
// Series colors are theme tokens, read at draw time so dark/light both work.
const PALETTE = ["accent", "dev", "stg", "ok", "syn-param", "syn-num"];

const num = (v: Cell) => (v === null ? 0 : Number(v));
const label = (v: Cell) => (v === null ? "NULL" : String(v));
const compact = new Intl.NumberFormat("en-US", { notation: "compact" });
const full = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

interface Config {
  type: ChartType;
  x: string;
  ys: string[];
  series: string;
  sort: boolean;
  labels: boolean;
}

function buildOption(result: ResultSet, cfg: Config, width: number): EChartsCoreOption {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  const idx = (name: string) => result.columns.findIndex((c) => c.name === name);
  const xi = idx(cfg.x);
  const yis = cfg.ys.map(idx);
  const si = cfg.series ? idx(cfg.series) : -1;
  const rows = cfg.sort ? [...result.rows].sort((a, b) => num(b[yis[0]]) - num(a[yis[0]])) : result.rows;
  const mono = { fontFamily: v("font-mono"), fontSize: 11 };
  const valueLabel = { show: cfg.labels, color: v("muted"), ...mono, formatter: (p: { value: number }) => compact.format(p.value) };
  const tooltip = {
    backgroundColor: v("raised"),
    borderColor: v("border-strong"),
    textStyle: { color: v("text"), fontSize: 12 },
    valueFormatter: (n: number) => full.format(n),
  };

  if (cfg.type === "pie")
    return {
      color: PALETTE.map(v),
      tooltip: { ...tooltip, trigger: "item" },
      series: [
        {
          type: "pie",
          radius: ["35%", "70%"],
          itemStyle: { borderColor: v("bg"), borderWidth: 2 },
          label: { color: v("muted"), formatter: cfg.labels ? "{b}: {d}%" : "{b}" },
          data: rows.map((r) => ({ name: label(r[xi]), value: num(r[yis[0]]) })),
        },
      ],
    };

  let cats = rows.map((r) => label(r[xi]));
  let data: { name: string; values: number[] }[];
  if (si >= 0) {
    // Pivot: one series per distinct group value, summing the first Y column.
    cats = [...new Set(cats)];
    const groups = [...new Set(rows.map((r) => label(r[si])))];
    data = groups.map((g) => ({
      name: g,
      values: cats.map((c) =>
        rows.filter((r) => label(r[xi]) === c && label(r[si]) === g).reduce((s, r) => s + num(r[yis[0]]), 0),
      ),
    }));
  } else data = cfg.ys.map((name, i) => ({ name, values: rows.map((r) => num(r[yis[i]])) }));

  const kind = cfg.type === "area" ? "line" : cfg.type;
  return {
    color: PALETTE.map(v),
    grid: { left: 8, right: 16, top: data.length > 1 ? 36 : 12, bottom: 8, containLabel: true },
    legend: data.length > 1 ? { top: 0, textStyle: { color: v("muted") } } : undefined,
    tooltip: { ...tooltip, trigger: cfg.type === "scatter" ? "item" : "axis", axisPointer: { type: "shadow" } },
    xAxis: {
      type: "category",
      data: cats,
      axisLine: { lineStyle: { color: v("border-strong") } },
      axisTick: { show: false },
      axisLabel: {
        color: v("muted"),
        fontSize: 11,
        interval: 0,
        overflow: "truncate",
        width: Math.max(32, (width - 80) / Math.max(1, cats.length) - 8),
      },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: v("faint"), ...mono, formatter: (n: number) => compact.format(n) },
      splitLine: { lineStyle: { color: v("border"), type: "dashed" } },
    },
    series: data.map((s) => ({
      name: s.name,
      type: kind,
      data: s.values,
      label: { ...valueLabel, position: "top" },
      emphasis: { itemStyle: { color: v("accent-strong") } },
      ...(kind === "bar" && { itemStyle: { borderRadius: [4, 4, 0, 0] }, barCategoryGap: "22%" }),
      ...(kind === "line" && { smooth: false, symbolSize: 6 }),
      ...(cfg.type === "area" && { areaStyle: { opacity: 0.22 } }),
      ...(kind === "scatter" && { symbolSize: 10 }),
    })),
  };
}

function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

export function ChartView({ result }: { result: ResultSet }) {
  const t = useT();
  const axes = useMemo(() => suggestAxes(result.columns), [result]);
  const [cfg, setCfg] = useState<Config>({
    type: "bar",
    x: axes?.x ?? "",
    ys: axes ? [axes.y] : [],
    series: "",
    sort: true,
    labels: false,
  });
  const set = (p: Partial<Config>) => setCfg((c) => ({ ...c, ...p }));
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [width, setWidth] = useState(0);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (!box.current) return;
    const c = echarts.init(box.current);
    chart.current = c;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, [axes]);

  useEffect(() => {
    if (!chart.current || !axes) return;
    chart.current.resize();
    chart.current.setOption(buildOption(result, cfg, width), true);
  }, [result, cfg, width, themeTick, axes]);

  if (!axes) return <p className="m-0 grid flex-1 place-items-center text-muted">{t("chart.noNumeric")}</p>;

  const title = t("chart.title", { y: cfg.ys.join(", "), x: cfg.x });
  const numeric = result.columns.filter((c) => c.numeric && c.name !== cfg.x);
  const nextY = numeric.find((c) => !cfg.ys.includes(c.name));
  const xCol = result.columns.find((c) => c.name === cfg.x);
  const yCol = result.columns.find((c) => c.name === cfg.ys[0]);

  const exportSvg = () => {
    const c = chart.current!;
    const svg = echarts.init(document.createElement("div"), undefined, {
      renderer: "svg",
      width: c.getWidth(),
      height: c.getHeight(),
    });
    svg.setOption({ ...buildOption(result, cfg, width), animation: false });
    download(svg.getDataURL(), `${title}.svg`);
    svg.dispose();
  };
  const exportPng = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    download(chart.current!.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg }), `${title}.png`);
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <section aria-label={t("chart.label")} className="flex min-w-[520px] flex-[999_1_520px] flex-col gap-4 px-7 pt-6 pb-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="m-0 text-base font-semibold">{title}</h2>
          <span className="text-xs text-muted">
            {t("chart.subtitle", { n: result.rows.length })}
            {cfg.sort && cfg.type !== "scatter" ? ` · ${t("chart.sorted")}` : ""}
          </span>
        </div>
        <div
          ref={box}
          role="img"
          aria-label={t("chart.aria", { type: t(`chart.type.${cfg.type}`), title })}
          className="min-h-[360px] flex-1"
        />
      </section>

      <aside
        aria-label={t("chart.settings")}
        className="flex max-w-80 min-w-[280px] flex-[1_1_300px] flex-col gap-[18px] overflow-y-auto border-l border-border bg-panel px-[18px] py-5"
      >
        <div>
          <SectionLabel className="mb-2">{t("chart.type")}</SectionLabel>
          <div role="group" aria-label={t("chart.type")} className="grid grid-cols-5 gap-1">
            {TYPES.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={cfg.type === o.value}
                onClick={() => set({ type: o.value })}
                className={cn(
                  "flex h-[52px] flex-col items-center justify-center gap-1 rounded-[7px] border text-[11px]",
                  cfg.type === o.value ? "border-accent bg-accent-bg" : "border-border bg-surface text-muted hover:text-text",
                )}
              >
                {o.icon}
                {t(`chart.type.${o.value}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Field label={t("chart.x")}>
            <ColumnSelect
              value={cfg.x}
              columns={result.columns}
              onChange={(x) => set({ x, ys: cfg.ys.filter((y) => y !== x), series: cfg.series === x ? "" : cfg.series })}
            />
          </Field>
          <div>
            <Field label={t("chart.y")}>
              <ColumnSelect
                value={cfg.ys[0] ?? ""}
                columns={numeric}
                swatch="var(--accent)"
                onChange={(y) => set({ ys: [y, ...cfg.ys.slice(1).filter((o) => o !== y)] })}
              />
            </Field>
            {cfg.ys.slice(1).map((y, i) => (
              <div key={y} className="mt-1.5 flex items-center gap-1">
                <span className="min-w-0 flex-1">
                  <ColumnSelect
                    label={t("chart.y")}
                    value={y}
                    columns={numeric}
                    swatch={`var(--${PALETTE[(i + 1) % PALETTE.length]})`}
                    onChange={(n) => set({ ys: cfg.ys.map((o) => (o === y ? n : o)).filter((o, j, a) => a.indexOf(o) === j) })}
                  />
                </span>
                <IconButton label={t("chart.removeY")} onClick={() => set({ ys: cfg.ys.filter((o) => o !== y) })}>
                  <X size={13} />
                </IconButton>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-1.5 px-1.5"
              disabled={!nextY || cfg.type === "pie"}
              onClick={() => nextY && set({ ys: [...cfg.ys, nextY.name] })}
            >
              <Plus size={13} aria-hidden="true" />
              {t("chart.addY")}
            </Button>
          </div>
          <Field label={t("chart.series")}>
            <ColumnSelect
              value={cfg.series}
              columns={result.columns.filter((c) => c.name !== cfg.x && !cfg.ys.includes(c.name))}
              noneLabel={t("common.none")}
              onChange={(series) => set({ series })}
            />
          </Field>
        </div>

        <p className="m-0 rounded-lg bg-surface px-3 py-2.5 text-xs text-muted">
          {t("chart.picked")} <span className="text-text">{xCol?.type} → X</span>,{" "}
          <span className="text-text">{yCol?.type} → Y</span>. {t("chart.changeAbove")}
        </p>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span>{t("chart.sort")}</span>
            <Switch label={t("chart.sort")} checked={cfg.sort} onChange={(sort) => set({ sort })} />
          </div>
          <div className="flex items-center justify-between">
            <span>{t("chart.labels")}</span>
            <Switch label={t("chart.labels")} checked={cfg.labels} onChange={(labels) => set({ labels })} />
          </div>
        </div>

        <span className="flex-1" />
        <div className="flex gap-2">
          <Button size="lg" className="flex-1" onClick={exportPng}>
            <Download size={13} aria-hidden="true" />
            PNG
          </Button>
          <Button size="lg" className="flex-1" onClick={exportSvg}>
            <Download size={13} aria-hidden="true" />
            SVG
          </Button>
        </div>
        <p className="m-0 text-[11.5px] text-faint">{t("chart.notSaved")}</p>
      </aside>
    </div>
  );
}
