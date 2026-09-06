# Register Enable

Register enable은 특정 clock edge에서 register가 새 값을 capture할지 기존 값을 유지할지 결정하는 data update condition이다.

```systemverilog
always_ff @(posedge clk) begin
    if (en)
        q <= d;
end
```

> Register enable의 첫 질문은 “어디에 enable을 넣을까?”가 아니라 “이 값은 지금 update될 필요가 있는가?”다.

공통 용어는 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md), 전체 power 관점은 [Low-Power RTL Design](overview.md)을 참고한다.

## 1. Why It Matters

Register가 매 cycle 바뀌면 다음 activity가 생길 수 있다.

- FF internal data switching
- Q output transition
- downstream combinational switching
- high-fanout bus routing activity

결과가 사용되지 않는 interval에 update를 멈추면 dynamic power를 줄일 가능성이 있다. 하지만 enable logic, feedback MUX, fanout와 timing cost가 추가될 수 있으므로 공짜 최적화는 아니다.

## 2. Hardware View

기능적으로 enable은 다음 next-state equation과 같다.

```text
q_next = en ? d : q
```

개념적인 hardware는 다음 중 하나가 될 수 있다.

```text
                 ┌───────────┐
d ──────────────►│           │
                 │ 2:1 MUX   ├──► D  [FF]  Q ──┐
q feedback ─────►│           │                │
                 └─────▲─────┘                │
                       │                      │
                       en                     └── feedback
```

또는 target library/flow에 따라 enable-capable sequential cell이나 clock-gating transformation으로 mapping될 수 있다. RTL만 보고 어느 구현이 선택됐는지 단정하지 않는다.

## 3. RTL Patterns

### 3.1 Basic enable

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        valid <= 1'b0;
    else if (accept)
        valid <= next_valid;
end
```

`accept == 0`이면 `valid`는 hold한다. 이 hold가 specification인지 확인해야 한다.

### 3.2 Clear, load, update priority

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        count <= '0;
    else if (clear)
        count <= '0;
    else if (load)
        count <= load_value;
    else if (count_en)
        count <= count + 1'b1;
end
```

이 구조는 다음 priority를 만든다.

```text
reset > clear > load > count > hold
```

`clear && load`, `load && count_en`이 legal한지와 winner가 specification인지 review한다.

### 3.3 Data와 valid를 함께 관리

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        out_valid <= 1'b0;
    end else begin
        out_valid <= in_valid;

        if (in_valid)
            out_data <= transformed_data;
    end
end
```

Invalid cycle에 `out_data`가 stale value를 유지해도 consumer가 `out_valid`로 mask한다면 기능적으로 안전할 수 있다. 보기 좋은 zero를 만들기 위해 매번 clear하지 않는다.

## 4. Enable이 줄이는 것과 줄이지 못하는 것

Register enable은 해당 FF의 data update를 막는다. 그러나 `d`를 만드는 upstream combinational logic이 계속 입력 변화를 받으면 내부 switching은 남을 수 있다.

```text
changing operands ──> large combinational block ──> enabled FF
                         still toggles                holds
```

따라서 다음을 구분한다.

| 목표 | 적합한 검토 대상 |
|---|---|
| FF/Q update 감소 | Register enable |
| Upstream combinational activity 감소 | Operand isolation, source gating |
| 많은 FF의 clock pin activity 감소 | Inferred/explicit clock gating |
| Logic 자체가 필요 없음 | Removal |

## 5. Enable Generation Cost

### Existing control reuse

이미 존재하는 registered state나 valid가 정확한 update window를 표현한다면 재사용할 수 있다.

```systemverilog
assign count_en = (state == MEASURE) && event_c;
```

하지만 state decode가 late-arriving하거나 high fanout이면 timing과 routing을 악화시킬 수 있다.

### New enable state

별도 FF로 update window를 저장하면 semantics가 명확해질 수 있다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        active <= 1'b0;
    else if (start)
        active <= 1'b1;
    else if (done)
        active <= 1'b0;
end
```

추가 비용:

- enable FF와 clock/reset power
- start/done priority
- fanout와 routing
- CDC가 필요한 start/done crossing
- formal state space

작은 data register에서는 enable overhead가 절감보다 클 수 있다.

## 6. Synthesis View

Synthesis 후 다음을 확인한다.

- feedback MUX가 data critical path에 들어갔는가?
- library의 enable cell로 mapping됐는가?
- 여러 register가 공통 enable을 공유해 gating candidate가 됐는가?
- 복잡한 enable expression이 duplicate 또는 high-fanout net이 됐는가?
- constant/unused branch가 제거됐는가?
- RTL enable이 실제 clock gating으로 변환됐는가, 아니면 data MUX로 남았는가?

“Tool이 알아서 gating한다”는 assumption은 report로 확인해야 한다.

## 7. Timing Impact

Enable은 다음 path를 만들 수 있다.

```text
state/control FF ── decode ── enable/select ── destination D or gating enable
```

주요 위험:

- late state decode
- high-fanout common enable
- clear/load/count priority depth
- enable MUX가 arithmetic result 뒤에 연결
- inferred gating 시 clock-gating setup/hold check

Enable 추가 후 data setup뿐 아니라 hold, clock-gating check와 physical fanout를 확인한다.

## 8. Power and Area Impact

### 기대 가능한 power 효과

- FF internal/Q transition 감소
- downstream cone activity 감소 가능
- 공통 enable이 clock gating으로 구현되면 clock load activity 감소 가능

### 남는 또는 증가하는 power

- enable decode switching
- feedback MUX switching
- enable net buffer/routing
- 새 control FF clock/reset power
- upstream datapath activity

### Area

Feedback MUX, enable cell, decode, buffer와 control FF가 늘 수 있다. 반대로 불필요한 clear/update term을 제거하면 control cone이 줄 수 있다. 최종 netlist와 physical report로 판단한다.

## 9. Register Enable vs Clock Gating

| 항목 | Register enable | Clock gating |
|---|---|---|
| Functional expression | data update 여부 | clock edge 전달 여부 |
| 일반 RTL | `if (en) q <= d;` | technology/flow가 관리하는 ICG 구조 |
| 직접 줄이는 activity | data/Q update | clock pin과 gated clock tree activity |
| 위험 | MUX/decode/fanout | glitch, gating check, test/reset/wake-up |

Register enable은 functional intent를 표현하는 일반적인 출발점이다. 실제 gating 전략은 [Clock Gating](../06_clock/clock_gating.md)과 [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md)을 참고한다.

## 10. When Not to Add an Enable

- Register가 거의 매 cycle update된다.
- Enable logic이 data path보다 늦게 도착한다.
- Upstream switching이 power의 대부분이고 FF update 절감이 작다.
- 값 hold가 functional behavior를 바꾼다.
- Stale value가 debug/safety/interface requirement에 어긋난다.
- 새 enable state가 reset/CDC/control complexity를 크게 늘린다.
- Synthesis가 이미 동일한 조건을 최적화하고 있다.

Measure할 activity window와 overhead를 먼저 추정한다.

## 11. Verification Strategy

### Hold property

```systemverilog
ap_hold_when_disabled:
    assert property (@(posedge clk) disable iff (!rst_n)
        !en |=> $stable(q)
    );
```

Reset, clear와 load가 별도로 q를 바꿀 수 있다면 antecedent에서 해당 조건을 제외한다.

### Update property

```systemverilog
ap_update_when_enabled:
    assert property (@(posedge clk) disable iff (!rst_n)
        en |=> q == $past(d)
    );
```

실제 priority branch가 있으면 그 조건을 property에 반영한다.

### Observability

Optimization 전후 invalid 구간 값이 달라도 valid observation point에서 결과가 같다는 contract를 확인한다.

## 12. Common Mistakes

- 모든 register에 습관적으로 enable을 넣는다.
- Enable을 추가하면 upstream combinational logic도 멈춘다고 가정한다.
- `if (en)`만 보고 clock gating이 구현됐다고 주장한다.
- Enable과 clear/load priority를 specification 없이 정한다.
- Stale data와 invalid data를 구분하지 않는다.
- Enable fanout와 late decode timing을 무시한다.
- Power 비교에서 enable generation overhead를 제외한다.

## 13. Design Review Checklist

- [ ] 해당 register가 inactive interval에 update될 필요가 없는가?
- [ ] Hold된 stale value가 모든 consumer에서 invalid로 처리되는가?
- [ ] Clear/load/update/hold priority가 명세와 일치하는가?
- [ ] Existing control을 정확히 재사용할 수 있는가?
- [ ] 새 enable FF의 area, clock/reset power와 상태 복잡도를 포함했는가?
- [ ] Upstream combinational switching은 남지 않는가?
- [ ] Enable MUX와 fanout가 critical path를 만들지 않는가?
- [ ] Clock gating inference를 기대한다면 실제 report로 확인했는가?
- [ ] Representative workload에서 before/after activity와 PPA를 비교했는가?
- [ ] Hold/update/observational-equivalence property를 검증했는가?

## 관련 문서

- [Enable Everywhere](../14_anti_patterns/enable_everywhere.md): fine-grain enable의 손익과 implementation evidence
- [Low-Power RTL Design](overview.md)
- [Counter Optimization](counter_optimization.md)
- [Operand Isolation](operand_isolation.md)
- [Clock Gating](../06_clock/clock_gating.md)
- [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md)
