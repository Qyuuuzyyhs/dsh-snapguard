/**
 * dsh-snapguard 客户端面板 —— 手工产出的 bundle（无需构建工具）。
 * 挂载点：设置页「快照守卫 🐋」section（与插件市场同级入口），
 * 提供：状态总览、立即快照、回滚、删除快照、恢复出厂设置、自动开关。
 * 所有交互都直接调用宿主 /snapguard/* API，不需要与 Agent 对话。
 */
window.__ModuleLoader__.load({
	id: "dsh-snapguard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		// ── 样式 ─────────────────────────────────────────────────────
		const css = `
.sg-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;padding:14px 16px;margin:10px 0;color:var(--dsw-alias-label-primary,#1f2328)}
.sg-title{font-size:15px;font-weight:600;margin:0 0 4px}
.sg-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin:0 0 10px}
.sg-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0}
.sg-btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer}
.sg-btn:hover{filter:brightness(.97)}
.sg-btn:disabled{opacity:.55;cursor:default}
.sg-btn.primary{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:transparent;color:#fff}
.sg-btn.danger{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:transparent;color:#fff}
.sg-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-brand-primary,#4f6ef7)}
.sg-list{margin-top:6px}
.sg-item{display:flex;align-items:center;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);padding:8px 2px;font-size:13px;min-width:0}
.sg-item .grow{flex:1;min-width:0}
.sg-item .meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.sg-badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef0f3);color:var(--dsw-alias-label-secondary,#6b7280);margin-left:6px}
.sg-badge.auto{background:#eef4ff;color:#3b5bdb}
.sg-badge.crash{background:#fdeaea;color:#b91c1c}
.sg-badge.factory{background:#fdf3e3;color:#92400e}
.sg-toggle{display:inline-flex;align-items:center;gap:6px;font-size:13px;margin-right:14px;cursor:pointer;user-select:none}
.sg-err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;margin:6px 0}
.sg-ok{color:#15803d;font-size:12px;margin:6px 0}
.sg-warn{border:1px solid #f3d6c3;background:#fdf3e3;border-radius:8px;padding:10px 12px;font-size:12px;color:#7c4a03;margin:8px 0}
`;
		const tagId = "dsh-snapguard/GuardSection.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-snapguard";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const NAME = "dsh-snapguard";
		const REASON_LABEL = {
			auto: "自动",
			manual: "手动",
			"boot-crash": "崩溃自愈",
			"pre-factory": "出厂前备份",
			"pre-rollback": "回滚后悔药",
			"safe-mode-before": "安全模式前",
			unknown: "未知",
		};
		const NON_GOOD = new Set(["pre-rollback", "pre-boot", "pre-factory"]);

		async function api(path, body) {
			const res = await fetch(path, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				cache: "no-store",
			});
			let parsed = null;
			try {
				parsed = await res.json();
			} catch {
				parsed = null;
			}
			return { status: res.status, body: parsed };
		}

		function GuardSection() {
			const [data, setData] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);
			const [confirmFactory, setConfirmFactory] = React.useState(false);
			const [keepMarket, setKeepMarket] = React.useState(true);

			const refresh = React.useCallback(async () => {
				try {
					const result = await api("/snapguard/status");
					if (result.status === 200 && result.body !== null) setData(result.body);
					else setMessage({ kind: "err", text: "状态读取失败" });
				} catch {
					setMessage({ kind: "err", text: "无法连接宿主 /snapguard 服务" });
				}
			}, []);
			React.useEffect(() => {
				refresh();
				// 客户端渲染健康心跳：面板活着 = 页面渲染正常（黑屏检测信号）
				const beat = () => { api("/snapguard/health", {}).catch(() => {}); };
				beat();
				const beatTimer = window.setInterval(beat, 60000);
				return () => window.clearInterval(beatTimer);
			}, [refresh]);

			const run = async (handler, label) => {
				setBusy(true);
				setMessage(null);
				try {
					const result = await handler();
					if (result === undefined || result === null || result.status < 500) {
						setMessage({ kind: result.body?.ok === false ? "err" : "ok", text: result.body?.error ?? `${label}完成` });
					} else {
						setMessage({ kind: "err", text: `${label}失败（HTTP ${result.status}）` });
					}
				} catch (error) {
					setMessage({ kind: "err", text: String(error && error.message ? error.message : error) });
				} finally {
					setBusy(false);
					refresh();
				}
			};

			const snapNow = () => run(async () => api("/snapguard/snapshot", {}), "快速快照");
			const restore = (id) => {
				if (!window.confirm("回滚会把插件清单、配置与插件本体恢复到该快照，并重启 DSH。确定？")) return;
				run(async () => api("/snapguard/restore", { snapshot: id }), "回滚");
			};
			const remove = (id) => {
				if (!window.confirm("删除后无法恢复（不影响当前运行状态），确定删除？")) return;
				run(async () => api("/snapguard/delete-snapshot", { snapshot: id }), "删除快照");
			};
			const safeModeOn = () => {
				if (!window.confirm("安全模式会临时停用除快照守卫外的全部用户插件（不删除任何文件），并重启 DSH。确定？")) return;
				run(async () => api("/snapguard/safe-mode", { action: "on" }), "进入安全模式");
			};
			const safeModeOff = () => {
				if (!window.confirm("退出安全模式将整体还原插件清单与配置，并重启 DSH。确定？")) return;
				run(async () => api("/snapguard/safe-mode", { action: "off" }), "退出安全模式");
			};
			const factory = () => {
				if (!confirmFactory) { setConfirmFactory(true); return; }
				run(async () => api("/snapguard/factory-reset", { keepMarket }), "恢复出厂");
				setConfirmFactory(false);
			};
			const restart = () => run(async () => api("/snapguard/restart", {}), "重启 DSH");
			const toggleAuto = (field) => () => run(async () => api("/snapguard/toggles", { [field]: !data[field] }), "切换开关");

			return React.createElement("div", null,
				React.createElement("h3", { className: "sg-title" }, "快照守卫 🐋 一键倒带"),
				React.createElement("p", { className: "sg-sub" },
					`DSH 的保险丝：组合变化自动快照；启动崩溃自动回滚；一键回到原生状态。版本 ${data?.version ?? "…"}${data?.dshVersion ? ` · DSH ${data.dshVersion}` : ""}`),

				data === null && React.createElement("p", { className: "sg-sub" }, "加载中…"),

				data !== null && React.createElement(React.Fragment, null,
					// ── 状态行 ──
					React.createElement("div", { className: "sg-card" },
						React.createElement("div", { className: "sg-row" },
							React.createElement("label", { className: "sg-toggle" },
								React.createElement("input", {
									type: "checkbox",
									checked: data.autoSnapshot === true,
									disabled: busy,
									onChange: toggleAuto("autoSnapshot"),
								}),
								"自动快照",
							),
							React.createElement("label", { className: "sg-toggle" },
								React.createElement("input", {
									type: "checkbox",
									checked: data.autoRollback === true,
									disabled: busy,
									onChange: toggleAuto("autoRollback"),
								}),
								"崩溃自动回滚",
							),
						),
						React.createElement("div", { className: "sg-row" },
							React.createElement("button", { className: "sg-btn primary", disabled: busy, onClick: snapNow }, "🛟 立即快照"),
							React.createElement("button", { className: "sg-btn", disabled: busy, onClick: restart }, "🔄 重启 DSH"),
						),
						React.createElement("div", { className: "sg-row", style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary,#8b93a1)" } },
							data.state?.boot?.okAt !== null && data.state?.boot?.okAt !== undefined
								? `本次启动已就绪（${new Date(data.state.boot.okAt).toLocaleString()}）`
								: data.state?.boot?.startedAt !== null && data.state?.boot?.startedAt !== undefined
									? `上次启动 ${new Date(data.state.boot.startedAt).toLocaleString()} 未正常结束${data.state?.boot?.shutdownAt !== null && data.state?.boot?.shutdownAt !== undefined ? "（已正常退出）" : "——判定为崩溃"}` : "",
						),
					),

					// ── 快照列表 ──
					React.createElement("div", { className: "sg-card" },
						React.createElement("div", { className: "sg-title" }, `快照（${data.snapshots?.length ?? 0}）`),
						React.createElement("div", { className: "sg-list" },
							(data.snapshots ?? []).map((snap) => React.createElement("div", { key: snap.id, className: "sg-item" },
								React.createElement("div", { className: "grow" },
									React.createElement("span", null, REASON_LABEL[snap.reason] ?? snap.reason),
									!NON_GOOD.has(snap.reason) && React.createElement("span", { className: "sg-badge", style: { background: "#e8f6ec", color: "#15803d" } }, "✓ 良好"),
									React.createElement("span", { className: `sg-badge ${snap.reason === "auto" ? "auto" : snap.reason === "boot-crash" ? "crash" : snap.reason === "pre-factory" || snap.reason === "pre-rollback" ? "factory" : ""}` }, snap.reason),
									React.createElement("div", { className: "meta" },
										`${new Date(snap.createdAt).toLocaleString()} · 配置 ${snap.files} 项 · 插件 ${snap.packageCount} 个${snap.dshVersion ? ` · DSH ${snap.dshVersion}` : ""}`,
									),
								),
								React.createElement("button", { className: "sg-btn", disabled: busy, onClick: () => restore(snap.id) }, "↩ 回滚"),
								React.createElement("button", { className: "sg-btn ghost", disabled: busy, onClick: () => remove(snap.id) }, "删"),
							)),
							(data.snapshots ?? []).length === 0 && React.createElement("div", { className: "meta" }, "还没有快照——先点「立即快照」或等待自动快照"),
						),
					),

					// ── 安全模式（温和停用，不删东西）──
					data.safeMode?.active
						? React.createElement("div", { className: "sg-card", style: { border: "1px solid #f3d6c3", background: "#fdf3e3" } },
							React.createElement("div", { className: "sg-title" }, "⚠ 安全模式运行中"),
							React.createElement("div", { className: "sg-sub" },
								`自 ${data.safeMode.enteredAt ? new Date(data.safeMode.enteredAt).toLocaleString() : "未知"} 起，除快照守卫外所有用户插件已停用。${data.safeMode.backupMissing ? "【备份缺失警告】" : ""}`),
							React.createElement("div", { className: "sg-row" },
								React.createElement("button", { className: "sg-btn primary", disabled: busy, onClick: safeModeOff }, "✅ 退出安全模式并还原"),
							),
						)
						: React.createElement("div", { className: "sg-card" },
							React.createElement("div", { className: "sg-title" }, "🛟 安全模式"),
							React.createElement("div", { className: "sg-sub" }, "DSH 起不来时的温和自救：临时停用除快照守卫外的全部用户插件（不删除任何文件），重启后保证可启动；退出时一键还原。"),
							React.createElement("div", { className: "sg-row" },
								React.createElement("button", { className: "sg-btn", disabled: busy, onClick: safeModeOn }, "进入安全模式"),
							),
						),

					// ── 恢复出厂（危险区）──
					React.createElement("div", { className: "sg-card" },
						React.createElement("div", { className: "sg-title" }, "🏭 恢复出厂设置"),
						React.createElement("div", { className: "sg-warn" },
							"将删除全部第三方插件（含市场安装），只保留 DSH 官方组件与快照守卫；执行前会自动备份当前状态，完成后自动重启。",
						),
						React.createElement("label", { className: "sg-toggle", style: { margin: "6px 0" } },
							React.createElement("input", { type: "checkbox", checked: keepMarket, onChange: (e) => setKeepMarket(e.target.checked) }),
							"保留插件市场 dshmarket（推荐）",
						),
						React.createElement("div", { className: "sg-row" },
							React.createElement("button", { className: "sg-btn danger", disabled: busy, onClick: factory }, confirmFactory ? "⚠ 再点一次确认恢复出厂" : "恢复出厂设置"),
							confirmFactory && React.createElement("button", { className: "sg-btn", disabled: busy, onClick: () => setConfirmFactory(false) }, "取消"),
						),
					),
				),

				message !== null && React.createElement("p", { className: message.kind === "ok" ? "sg-ok" : "sg-err", style: { margin: "8px 0" } }, message.text),
			);
		}

		const name = NAME;
		const inject = ["slots", "locale", "theme"];
		function apply(ctx) {
			ctx.effect(() => {
				const off = ctx.slots.inject("settings.section", () => {
					const disposed = ctx.slots.register({
						name: "settings.section",
						id: "snapguard",
						order: 30,
						label: () => "快照守卫 🐋",
						locale: "dsh-snapguard",
					}, () => React.createElement(GuardSection, null));
					return typeof disposed === "function" ? disposed : undefined;
				});
				return typeof off === "function" ? off : undefined;
			}, "dsh-snapguard: settings section");
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
