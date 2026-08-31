# Synchronous vs Asynchronous Reset

Synchronous reset과 asynchronous reset의 차이는 coding taste가 아니라 **state가 언제 reset 값을 capture하는가**에 있다. Synchronous reset은 active clock edge가 필요하고, asynchronous reset은 target sequential cell의 asynchronous control을 통해 clock과 무관하게 assertion될 수 있다.

> 이 문서의 `srst_n`과 `local_arst_n`은 active-low다. `0`이 reset asserted, `1`이 deasserted다. `local_arst_n`은 raw global reset이 아니라 해당 clock domain에서 release가 안전하게 제어된 reset이라고 가정한다.

Reset requirement와 state inventory는 [Reset Architecture Overview](overview.md), raw async reset의 release 위험과 local synchronizer는 [Reset Deassertion and RDC](reset_deassertion.md)가 canonical하게 다룬다.

## 1. Hardware 차이

### Synchronous reset

```text
reset request ──> D-path/reset control ──> FF D
clock edge    ───────────────────────────> FF capture
```

Reset이 asserted되어도 active edge가 없으면 state는 바뀌지 않는다. RTL은 보통 clock-only sensitivity list와 reset 우선순위로 표현한다.

```systemverilog
always_ff @(posedge clk) begin
    if (!srst_n)
        q <= '0;
    else
        q <= d;
end
```

Mapped hardware는 data-input MUX, enable/control structure 또는 library가 제공하는 sequential cell feature가 될 수 있다. RTL만으로 mapping을 단정하지 않는다.

### Asynchronous reset

```text
async reset ───────────────> FF asynchronous control
clock/data ────────────────> normal capture path
```

Assertion은 active clock edge 없이 state를 reset할 수 있다.

```systemverilog
always_ff @(posedge clk or negedge local_arst_n) begin
    if (!local_arst_n)
        q <= '0;
    else
        q <= d;
end
```

이는 target library가 해당 polarity/value의 asynchronous control을 지원하고 synthesis/DFT flow가 올바르게 mapping한다는 조건이 필요하다. Deassertion은 recovery/removal와 RDC 문제이므로 raw source를 그대로 배포하지 않는다.

## 2. 같은 Functional Contract

두 예제는 reset 구현만 다르고 다음 contract는 같다.

- `DATA_W >= 1`만 지원한다.
- `load_valid`는 request이고 `load_accept = load_valid && load_ready`가 accepted event다.
- Reset 또는 `flush` 중 `load_ready=0`, `load_accept=0`이다.
- Event priority: reset → flush → accepted load → hold.
- Reset은 output valid와 payload를 모두 zero로 만든다. Resetless payload 판단은 별도 문서에서 다룬다.
- Reset release가 interface에서 관찰되기 전에 reset signal은 해당 clock에 대한 요구를 만족해야 한다.

### Synchronous reset version

`srst_n`은 `clk`에 동기적인 active-low control이며 setup/hold requirement를 만족한다고 가정한다.

```systemverilog
module synchronous_reset_stage #(
    parameter int unsigned DATA_W = 16
) (
    input  logic              clk,
    input  logic              srst_n,
    input  logic              flush,
    input  logic              load_valid,
    input  logic [DATA_W-1:0] load_data,
    output logic              load_ready,
    output logic              out_valid,
    output logic [DATA_W-1:0] out_data
);
    logic load_accept;

    assign load_ready  = srst_n && !flush;
    assign load_accept = load_valid && load_ready;

    // Event priority: synchronous reset > flush > accepted load > hold.
    always_ff @(posedge clk) begin
        if (!srst_n) begin
            out_valid <= 1'b0;
            out_data  <= '0;
        end else if (flush) begin
            out_valid <= 1'b0;
            out_data  <= '0;
        end else if (load_accept) begin
            out_valid <= 1'b1;
            out_data  <= load_data;
        end
    end
endmodule
```

`srst_n`이 low인 동안 clock이 멈추면 `load_ready`는 low이지만 register reset은 아직 적용되지 않을 수 있다. State가 실제 reset되었다고 보고하려면 required active edge를 확인해야 한다.

### Asynchronous reset version

`local_arst_n`은 active-low이며 assertion은 비동기, deassertion은 이미 `clk` domain에 대해 controlled되었다고 가정한다.

```systemverilog
module asynchronous_reset_stage #(
    parameter int unsigned DATA_W = 16
) (
    input  logic              clk,
    input  logic              local_arst_n,
    input  logic              flush,
    input  logic              load_valid,
    input  logic [DATA_W-1:0] load_data,
    output logic              load_ready,
    output logic              out_valid,
    output logic [DATA_W-1:0] out_data
);
    logic load_accept;

    assign load_ready  = local_arst_n && !flush;
    assign load_accept = load_valid && load_ready;

    // Event priority: asynchronous reset > flush > accepted load > hold.
    always_ff @(posedge clk or negedge local_arst_n) begin
        if (!local_arst_n) begin
            out_valid <= 1'b0;
            out_data  <= '0;
        end else if (flush) begin
            out_valid <= 1'b0;
            out_data  <= '0;
        end else if (load_accept) begin
            out_valid <= 1'b1;
            out_data  <= load_data;
        end
    end
endmodule
```

이 예제에 raw external reset을 `local_arst_n`으로 직접 연결하는 것은 contract 위반이다. Async assertion이 필요해도 release는 destination domain의 reset architecture를 거쳐야 한다.

## 3. Cycle and Priority Audit

아래 표는 reset signal이 E1 setup 전에 안전하게 high가 된 경우 두 구현에 공통이다.

```text
edge                            E0          E1          E2          E3
reset_n/flush/load_valid/data   0/0/1/A     1/0/1/A     1/1/1/B     1/0/1/B
load_ready/load_accept          0/0         1/1         0/0         1/1
out_valid after edge            0           1           0           1
out_data after edge             0           A           0           B
winning event                   reset       accept      flush       accept
```

- E0에서 request가 있어도 acceptance는 없다.
- E1은 reset release 뒤 첫 accepted transaction이다.
- E2의 request는 flush와 겹쳐 accept되지 않는다.
- E3에서 producer가 B를 유지하거나 재시도하면 accept된다.

두 구현의 차이는 **reset signal 자체가 E0 state를 만드는 방법**이다. Synchronous version은 E0 active edge가 필요하고 asynchronous version은 `local_arst_n` negedge로 clock 없이 state를 reset할 수 있다. Domain-local async release가 clock edge 직후 NBA로 올라오는 구조라면 downstream의 첫 normal capture는 그 다음 edge이며, 이는 [Reset Deassertion and RDC](reset_deassertion.md)의 cycle table에서 다룬다.

## 4. Assertion 비교

### Synchronous assertion

- Reset source가 clock에 안정적으로 도달해야 한다.
- At least one required active edge가 있어야 state가 reset된다.
- Clock gating, clock mux 또는 PLL unavailable 상태에서는 assertion이 지연될 수 있다.
- Reset을 즉시 interface backpressure로 사용할 수 있어도 internal state reset completion은 별도다.

### Asynchronous assertion

- Supported async control을 통해 clock 없이 state를 바꿀 수 있다.
- Minimum pulse width, polarity와 cell recovery behavior를 만족해야 한다.
- Reset source glitch/pulse가 functional state를 직접 바꿀 수 있으므로 source qualification이 중요하다.
- 여러 domains에 도달하는 assertion skew와 power/isolation sequence를 검토한다.

Asynchronous가 “더 빠르다”는 표현은 assertion latency만 본 것이다. Release, reset tree, DFT와 physical sign-off까지 포함한 전체 recovery latency는 architecture에 따라 달라진다.

## 5. Deassertion 비교

Synchronous reset signal이 source부터 `clk` domain에 synchronous하고 setup/hold를 만족한다면 release는 normal synchronous control로 분석할 수 있다. 그러나 asynchronous source를 단지 synchronous-reset `if` 조건에 연결한다고 안전해지는 것은 아니다. Source가 destination edge 근처에서 변하면 해당 D/reset control path의 setup/hold 문제가 생길 수 있다.

Asynchronous reset deassertion은 async control의 recovery/removal window를 위반할 수 있다. Reset tree skew 때문에 FF들이 다른 cycle에 release될 수도 있다. 일반적인 방향은 다음과 같다.

```text
raw async reset source
        ├─ asynchronous assertion into local reset chain
        └─ destination-clock synchronized deassertion
                         ↓
                  local_arst_n
```

Release synchronizer는 assertion을 지연시키는 data synchronizer가 아니며, clock이 멈추면 release를 완료하지 못한다.

## 6. Clock가 멈춘 경우

| 상황 | Synchronous reset | Async assertion + controlled release |
|---|---|---|
| Function clock off에서 assertion | State에 적용되지 않음 | Async-capable state는 assertion 가능 |
| Function clock off에서 release | Edge가 없어 의미 있는 progress 없음 | Local release synchronizer가 진행하지 않음 |
| Clock resume | Required reset edge/sequence 필요 | Release chain을 채울 clean edges 필요 |
| Ready 시점 | Reset capture와 init 확인 뒤 | Local reset release와 init 확인 뒤 |

Clock을 억지로 raw OR/AND하여 reset edge를 만들지 않는다. [Reset with Clock Gating](reset_with_clock_gating.md)의 force-on/availability/release protocol을 사용한다.

## 7. Reset Priority와 Normal Control

Reset priority는 code ordering 이상의 functional contract다.

- Reset + flush: reset state가 이긴다.
- Reset + load-valid: ready/accept가 false이고 load는 처리되지 않는다.
- Flush + load-valid: flush가 이기고 request는 accept되지 않는다.
- Release + load-valid: ready가 실제로 high인 edge만 acceptance다.
- Back-to-back reset: 진행 중 initialization을 restart/coalesce/queue할지 정의한다.

Synchronous reset이 data/control MUX로 구현될 때 reset priority가 critical D path에 들어갈 수 있다. Async reset은 D path에서 reset MUX를 피할 가능성이 있지만 cell choice와 recovery/removal 부담을 만든다. 실제 mapping을 report로 확인한다.

## 8. Cell, Inference, Retiming과 DFT

### Cell and synthesis

- Target library가 필요한 polarity/value의 sync/async reset cell을 제공하는가?
- Polarity inversion이나 reset MUX가 추가되는가?
- Reset semantics가 다른 FF가 merge/pack되지 않는가?
- Pipeline retiming이나 memory/register inference가 제한되는가?
- Tool이 async control을 예상한 pin에 mapping했는가?

“Async FF가 항상 크다/작다”, “Sync reset MUX가 항상 data path에 있다”와 같은 결론은 library-dependent다.

### DFT and test

- Scan shift/capture에서 reset을 어떻게 hold 또는 release하는가?
- Test enable과 reset override priority가 정의됐는가?
- Asynchronous reset pulse가 scan state를 의도치 않게 지우지 않는가?
- At-speed test가 recovery/removal와 gated clock relationship을 보존하는가?
- Memory BIST와 local reset ordering이 맞는가?

구체적인 bypass나 cell instance는 project DFT methodology를 따른다.

## 9. STA, RDC와 Physical View

### STA

Synchronous reset:

- Reset control path setup/hold
- Reset MUX and data path interaction
- Clock availability and generated-clock modes

Asynchronous reset:

- Recovery/removal
- Minimum pulse width
- Reset deassertion relationship to each destination clock
- Release synchronizer stage timing

Broad false-path로 reset 관련 check를 숨기지 않는다. 어떤 async source path를 예외 처리하더라도 local chain과 downstream release가 methodology대로 분석되는지 확인한다.

### RDC

- Raw async deassertion fanout
- Different reset types/polarities reconverging
- One-sided reset and stale state
- Reset-domain crossing controls and acknowledgements
- Reset synchronizer recognition and waiver justification

### Physical

- Reset tree fanout, skew and route span
- Resettable-cell placement
- Clock/reset tree interaction
- Local release chain placement and first-stage fanout
- Congestion and simultaneous switching during reset

## 10. Timing, Power, Area Trade-off

| Choice | Timing | Power | Area | Verification risk |
|---|---|---|---|---|
| Synchronous reset | reset D-path/setup 영향 가능 | reset edge에 clock 필요 | MUX/cell 의존 | stopped clock |
| Asynchronous reset | recovery/removal | clock 없이 assertion | async cell/tree 의존 | raw release/RDC |
| Local release synchronizer | release latency 추가 | small clock activity | stage/tree 추가 | clock availability |
| Reset all payload | reset path/fanout 증가 | reset switching | cell/tree 증가 가능 | deterministic data |
| Reset control only | payload timing freedom 가능 | reset activity 감소 | area 감소 가능 | observer/X discipline |

PPA 수치는 [Reset Area Cost](../05_area/reset_area_cost.md)의 동일 boundary 조건으로 비교한다.

## 11. 적용하면 안 되는 경우

- Clock이 멈출 수 있는데 synchronous reset만으로 즉시 recovery를 요구하는 경우
- Raw asynchronous deassertion을 여러 FF에 직접 배포하는 경우
- Library/DFT support를 확인하지 않고 async reset style을 강제하는 경우
- Asynchronous source를 synchronous-reset condition에 연결하고 CDC/RDC 검토를 생략하는 경우
- Reset type 변경으로 first active cycle이나 interface ready가 바뀌는데 equivalence만 믿는 경우
- Area 추정만으로 functional reset requirement를 바꾸는 경우

## 12. Common Mistakes

- Async reset은 항상 빠르고 작다고 일반화한다.
- Sync reset은 항상 안전하다고 일반화한다.
- Sensitivity list만 보고 hardware와 release contract가 완성됐다고 본다.
- Clock이 멈춘 domain에서 synchronous reset이 이미 적용됐다고 보고한다.
- Active-low reset name과 실제 assertion polarity를 혼동한다.
- Reset signal deassert 순간을 block ready 순간으로 사용한다.
- Reset/flush/load-valid simultaneous case에서 raw valid를 transaction으로 센다.

## 13. Verification Strategy

### Common functional tests

- Reset at idle and while `out_valid=1`
- Reset/flush/load-valid simultaneous combinations
- Reset pulse around clock edges
- First request after release and back-to-back requests
- Clock stop before/during reset and restart
- Repeated reset before prior initialization completes

### SVA sampling guidance

Clocked concurrent assertion은 expression을 preponed region에서 sample하고 RTL nonblocking assignment는 이후에 state를 갱신한다. 따라서 같은 edge의 `reset -> out_valid=0`을 overlapping implication으로 쓰면 pre-reset value를 볼 수 있다.

Post-state를 확인하려면 다음 sampling edge에서 이전 event의 결과를 보는 형태가 더 명확할 수 있다.

```systemverilog
ap_flush_clears_valid:
    assert property (@(posedge clk) disable iff (!reset_n)
        flush |=> !out_valid
    );

ap_accept_presents_data:
    assert property (@(posedge clk) disable iff (!reset_n)
        load_accept |=> out_valid && (out_data == $past(load_data))
    );
```

여기서 `reset_n`은 각 module의 `srst_n` 또는 `local_arst_n`을 의미하는 설명용 이름이다. `|=>`의 consequent는 다음 clock sample에서, 즉 이전 edge NBA로 갱신된 state를 관찰한다. 다음 edge에 새 flush/reset이 발생하면 abort/priority contract에 맞춰 `disable iff`나 antecedent를 조정한다. Async assertion 자체의 sub-cycle latency는 clocked property 하나로 증명하지 않고 reset-edge monitor, structural check와 reset-aware simulation을 함께 사용한다.

## 14. Design Review Checklist

- [ ] Reset polarity와 assertion/deassertion 의미가 명시됐는가?
- [ ] Clock 없이 assertion해야 하는 functional requirement가 있는가?
- [ ] Synchronous reset에 필요한 active edge가 보장되는가?
- [ ] Async reset release가 destination별로 controlled되는가?
- [ ] Reset/flush/load-valid/accept priority가 RTL과 interface에 일치하는가?
- [ ] First active cycle과 ready timing이 cycle table에 있는가?
- [ ] Library cell, polarity, inference와 retiming 결과를 확인했는가?
- [ ] STA setup/hold 또는 recovery/removal check가 적용됐는가?
- [ ] DFT/scan/test reset override와 priority가 정의됐는가?
- [ ] Clock stop/restart와 back-to-back reset을 검증했는가?
- [ ] PPA를 reset tree와 physical overhead까지 포함해 비교했는가?

## 관련 문서

- [Reset Architecture Overview](overview.md)
- [Reset Deassertion and RDC](reset_deassertion.md)
- [Resetless Datapath](resetless_datapath.md)
- [Reset with Clock Gating](reset_with_clock_gating.md)
- [Reset Area Cost](../05_area/reset_area_cost.md)
- [Clock Gating](../06_clock/clock_gating.md)
