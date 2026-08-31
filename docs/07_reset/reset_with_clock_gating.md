# Reset with Clock Gating

Clock gating이 있는 block의 reset은 reset RTL만으로 해결되지 않는다. Synchronous reset에는 active function-clock edge가 필요하고, asynchronous assertion을 사용해도 safe deassertion에는 clean local clock edges가 필요하다. 따라서 clock availability, reset sequencing와 function readiness를 하나의 protocol로 설계한다.

> 이 문서에서 function clock은 project가 승인한 ICG/clock architecture가 제공한다고 가정한다. `assign function_clk = root_clk & enable` 같은 raw combinational clock 생성은 예제로도 사용하지 않는다.

Clock gating cell과 timing/DFT 책임은 [Clock Gating](../06_clock/clock_gating.md), root/function state partition은 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md), reset release structure는 [Reset Deassertion and RDC](reset_deassertion.md)가 canonical하게 다룬다.

## 1. 문제의 핵심

```text
root/always-on clock
        │
  reset/wake controller ── clock request ──> approved ICG/clock manager
        │                                      │
        │                                 function clock
        │                                      │
        └──── reset request/status ─────> function state
```

Function clock이 off인 동안 생기는 질문:

- Synchronous reset을 적용할 edge가 있는가?
- Async reset을 release할 local edges가 있는가?
- Reset request를 누가 기억하는가?
- Clock을 켜는 enable state가 어느 clock 아래에 있는가?
- Function이 언제 input을 다시 accept할 수 있는가?
- Test/scan이 gated branch clock을 어떻게 제어하는가?

Reset signal을 clock gate enable에 단순 OR하거나 clock을 raw logic로 우회하면 glitch, truncated pulse와 clock-gating check 문제를 만들 수 있다. Approved clock control interface에 **clock request intent**를 전달한다.

## 2. Synchronous Reset under a Stopped Clock

Synchronous reset은 `posedge function_clk`에서만 state에 적용된다.

```text
synchronous reset asserted
        │
function_clk stopped
        ↓
no capture edge ──> function state is not yet reset
```

가능한 architecture:

- Reset controller가 function clock을 force-on하고 required edges를 제공한다.
- Reset pending을 always-on state에 저장하고 clock resume 뒤 적용한다.
- Function payload는 reset하지 않고 valid/control만 reset하는 contract를 사용한다.
- Requirement가 허용하고 methodology가 지원하면 asynchronous assertion을 사용한다.

`ready=0`으로 external acceptance를 즉시 막는 것과 internal state가 synchronous reset edge를 실제로 받은 것은 별개다. `reset_done`은 후자를 확인한 뒤 assert해야 한다.

## 3. Asynchronous Reset under a Stopped Clock

Supported async control을 사용하면 assertion은 function clock 없이 적용될 수 있다. 그러나 raw source deassertion을 그대로 FF에 배포하지 않는다.

```text
async assertion while clock off ──> state reset possible
source deasserts while clock off ──> release chain cannot advance
clock resumes                    ──> clean edges fill release chain
local reset deasserts            ──> first normal function edge
```

Clock이 멈춘 상태에서 local reset이 asserted를 유지하는 것은 정상이다. 문제는 system이 local reset release를 기다리면서 clock을 켤 state도 같은 stopped clock 아래에 두는 circular dependency다.

## 4. Root/Always-on과 Function State Partition

| State/control | 권장 owner 질문 |
|---|---|
| Reset request capture | Function clock off 중에도 바뀌어야 하는가? |
| Clock force-on request | 자기 clock을 켜야 하므로 root/always-on인가? |
| Reset sequence phase | Function reset 중에도 progress해야 하는가? |
| Clock-available status | 어떤 domain에서 안전하게 관찰되는가? |
| Local release chain | 해당 function clock domain인가? |
| Function FSM/payload | Reset/clock off 동안 유지 또는 invalidate되는가? |
| Reset-done aggregation | Cross-domain status synchronization이 있는가? |

다음 구조는 self-deadlock이다.

```text
function clock off
        ↓
reset/clock-enable controller cannot update
        ↓
function clock cannot turn on
        ↓
reset release cannot complete
```

Always-on은 chip-wide power 의미가 아니라 해당 function clock이 off/reset인 동안에도 필요한 transition을 수행할 clock/control 경로를 뜻한다.

## 5. Safe Reset Sequence

Runtime/local reset의 generic sequence:

```text
1. reset request accepted by root controller
2. block new function acceptance immediately
3. request function clock force-on through approved clock architecture
4. confirm function clock availability/stability
5. assert function reset
6. satisfy minimum pulse/active-edge conditions and observe old `function_reset_done` clear
7. deassert reset request; fill per-domain release synchronizer
8. function reports reset_done/ready
9. synchronize/aggregate reset_done at root
10. restore normal clock-gating policy
```

Step 5–6 depends on reset style.

- Synchronous reset: provide the specified number of active function edges while reset is asserted.
- Asynchronous reset: satisfy cell/reset-network minimum assertion requirements; function clock is still required for controlled release.
- Mixed state: each state class must satisfy its own reset requirement before common `reset_done`.

Reset request와 normal function request가 같은 root edge에 오면 reset acceptance가 우선하고 function transaction은 accept하지 않는 contract가 명확하다. `function_in_ready`는 `!reset_valid`, `!reset_busy`와 synchronized function readiness로 qualify한다.

## 6. Controller/Function Pseudo-interface

Clock waveform를 RTL에서 생성하지 않고 다음 intent/status interface를 정의한다.

```text
root reset controller

inputs
  reset_valid                  active-high reset request
  normal_clock_request         normal function use
  test_clock_request           DFT/test request
  function_clock_available     root-safe clock-manager status
  assertion_window_complete    chosen pulse/edge requirement complete
  function_reset_done_sync     root-safe synchronized completion

outputs
  reset_ready                  request acceptance permission
  clock_force_on               request to approved clock architecture
  function_reset_req_n         active-low reset request to function endpoint
  reset_busy                   blocks function acceptance
```

Suggested state intent:

| State | Clock request | `function_reset_req_n` | Exit condition |
|---|---:|---:|---|
| NORMAL | normal/test policy | 1 | `reset_accept` |
| FORCE_ON | 1 | 1 | clock available |
| ASSERT_RESET | 1 | 0 | assertion window complete and synchronized done=0 |
| WAIT_RELEASE | 1 | 1 | synchronized `function_reset_done` |
| RETURN_NORMAL | 1 | 1 | root interface ready/ack complete |

`reset_accept = reset_valid && reset_ready`만 reset event로 센다. Simple controller가 reset 진행 중 새 request를 저장할 수 없다면 `reset_ready=0`으로 내려 producer가 유지/재시도하게 한다. Coalescing, restart 또는 queued reset이 필요하면 그 semantics와 completion count를 별도로 설계한다.

Previous reset의 `function_reset_done_sync=1`을 새 completion으로 오인하지 않도록 ASSERT_RESET phase에서 synchronized done가 0으로 내려간 것을 먼저 확인한다. 그 뒤 reset request를 release하고 새로운 0→1 completion을 기다린다. Pulse/epoch handshake를 사용한다면 동일한 stale-status 방지 contract를 명시한다.

`clock_force_on`은 clock net가 아니라 approved clock controller/ICG의 control input으로 전달되는 intent다. Test enable과의 실제 결합, safe-phase behavior와 cell instance는 project clock/DFT flow가 담당한다.

## 7. Generic Function Reset Endpoint

다음 endpoint는 active-low async assertion request를 local two-stage release chain으로 처리하고, downstream이 normal edge를 한 번 받은 뒤 `function_reset_done`을 assert한다.

```systemverilog
module function_reset_endpoint (
    input  logic function_clk,
    input  logic function_reset_req_n,
    output logic local_reset_n,
    output logic function_reset_done
);
    logic [1:0] release_q;

    // function_reset_req_n: active-low asynchronous assertion request.
    always_ff @(posedge function_clk or negedge function_reset_req_n) begin
        if (!function_reset_req_n) begin
            release_q <= 2'b00;
        end else begin
            release_q <= {release_q[0], 1'b1};
        end
    end

    assign local_reset_n = release_q[1];

    // local_reset_n rises after the release-chain NBA update.
    // The following clock edge is the first normal edge for this state.
    always_ff @(posedge function_clk or negedge local_reset_n) begin
        if (!local_reset_n) begin
            function_reset_done <= 1'b0;
        end else begin
            function_reset_done <= 1'b1;
        end
    end
endmodule
```

`function_reset_done`은 function-domain signal이다. Root controller가 사용하려면 clock relationship에 맞는 status synchronization/handshake가 필요하다. 이 endpoint는 clock availability, ICG, test override 또는 system reset ordering을 구현하지 않는다.

Project flow는 release stages의 synchronizer identification, placement, recovery/removal와 local reset distribution을 검증해야 한다. Fixed two-stage가 모든 reliability target의 충분조건이라고 가정하지 않는다.

## 8. Sequence and Cycle Audit

Controller phase와 function edges를 분리해 본다.

```text
phase/event                    P0         P1          P2          F1/F2       F3        P3
reset request                 accept     busy        busy        busy        busy      done sync
clock_force_on                1          1           1           1           1         normal policy
clock available               0          1           1           1           1         1
function_reset_req_n          1          0           1           1           1         1
release_q after function edge -          00          00          01/11       11        11
local_reset_n                 previous   0           0           0/1         1         1
function_reset_done           0          0           0           0           1         1
function acceptance           blocked    blocked     blocked     blocked     blocked   allowed after root ack
```

- P0에서 reset과 normal clock request가 동시에 와도 reset sequence가 이긴다.
- P1에서 clock availability를 확인한 뒤 reset을 assert한다.
- P2는 assertion pulse/edge requirement가 완료되고 root가 synchronized done=0을 관찰한 뒤 reset request를 deassert한 시점이다.
- F1/F2가 release chain을 채운다. F2 NBA 뒤 `local_reset_n`이 high가 된다.
- F3가 endpoint state의 첫 normal edge이고 `function_reset_done`이 high가 된다.
- Root는 synchronized done을 본 뒤에만 function acceptance와 normal gating policy를 복원한다.

Clock manager latency, clock ratios와 status synchronization 때문에 P0–P3는 fixed number of root cycles가 아닐 수 있다. Protocol은 liveness assumption과 timeout/error policy를 가져야 한다.

## 9. Reset and Clock-enable Simultaneous Events

Priority recommendations are functional contracts, not universal syntax:

1. Root controller reset
2. Accepted function reset request
3. Test/scan clock requirement as defined by DFT mode
4. Normal wake/function clock request
5. Idle gating request

Test mode priority는 methodology에 따라 다를 수 있으므로 RTL guide에서 고정하지 않는다. 중요한 것은 functional and test modes 각각에서 clock availability와 reset state가 모호하지 않은 것이다.

Function input handshake:

```text
function_accept = function_valid
                && function_ready
                && !reset_valid
                && !reset_busy
```

실제 design에서는 combinational loop가 생기지 않도록 readiness owner와 registered boundary를 정한다. Reset request가 asynchronous source이면 먼저 root domain에서 보존/동기화한 뒤 `reset_valid` protocol로 만든다.

## 10. Back-to-back Reset and Missing Clock

### Back-to-back reset

정책 후보:

- Busy 동안 `reset_ready=0`; second request를 producer가 hold
- 새 accepted reset이 sequence를 처음부터 restart
- Multiple requests를 coalesce하고 하나의 completion 반환
- Requests를 count/queue하고 각각 completion

각 정책은 side effect와 response count가 다르다. “Reset은 idempotent하므로 상관없다”라고 가정하지 않는다. Software-visible acknowledgement나 safety event accounting은 idempotent하지 않을 수 있다.

### Missing clock

`clock_force_on=1`인데 `function_clock_available` 또는 `function_reset_done`이 오지 않을 수 있다.

- Stay reset-busy and block acceptance
- Raise timeout/error to an always-on observer
- Retry/reconfigure clock source if architecture permits
- Escalate to a broader recovery domain

Timeout counter와 error state는 function clock 아래에 두지 않는다. Formal liveness property에는 clock manager가 eventually edges/status를 제공한다는 assumption 또는 timeout outcome을 포함한다.

## 11. DFT, Scan and Test

Clock gating과 reset의 test behavior를 함께 정의한다.

- ICG test enable/scan enable path uses characterized safe clock control
- Scan shift/capture 중 function reset hold/release policy
- Test enable과 functional `clock_force_on` priority
- At-speed test에서 recovery/removal and gating checks
- Memory BIST/local reset ordering
- Reset controller 자체의 scan controllability and observability

Raw OR/AND clock bypass를 test 예외로 추가하지 않는다. Approved ICG/test interface와 DFT constraints를 사용한다.

## 12. STA, RDC and Physical View

### STA

- ICG enable clock-gating setup/hold
- Root/generated/function clock relationships by mode
- Reset recovery/removal and minimum pulse width
- Clock-start/reset-release modes and constraints
- Reset-done status synchronization timing

### RDC/CDC

- Reset request source into root controller
- Function reset release chain recognition
- Function done crossing back to root
- One-sided reset with retained peer domains
- Clock stop/restart handshake and stale status

### Physical

- ICG placement and sink clustering
- Clock force-on/test-enable routing
- Reset tree and release-chain placement
- Local reset fanout, skew and congestion
- Root controller locality to clock manager/status synchronizers

Clock off mode를 broad false-path로 제외해 reset/test/wake paths를 숨기지 않는다.

## 13. Timing, Power, Area Trade-off

| Choice | Timing/latency | Power | Area | Risk |
|---|---|---|---|---|
| Keep function clock on for reset | predictable edges | reset 동안 clock activity | no extra pending path | power spike |
| Async assertion + local release | release latency | small release-chain activity | chain/reset tree | recovery/RDC |
| Resetless payload | init latency 감소 가능 | reset activity 감소 | reset load 감소 가능 | observer/X |
| Always-on controller | wake/reset progress | continuous small clock load | control state | partition complexity |
| Timeout/error monitor | bounded failure response | counter activity | counter/status | false escalation |

Clock gating의 measured power 이익에는 reset/wake/test overhead를 포함한다. Reset Area 세부 비용은 [Reset Area Cost](../05_area/reset_area_cost.md)를 따른다.

## 14. 적용하면 안 되는 경우

- Raw combinational logic로 gated clock이나 reset clock pulse를 만드는 경우
- Clock enable/reset sequencer를 같은 stopped function clock 아래에 두는 경우
- Synchronous reset을 적용할 function edges를 보장하지 못하는 경우
- Async reset을 clock off에서 raw deassert하고 ready를 즉시 올리는 경우
- Function reset-done을 동기화 없이 root controller가 사용하는 경우
- DFT/test clock control과 reset priority가 정의되지 않은 경우
- Missing clock에 timeout/error path 없이 무기한 completion을 가정하는 경우

## 15. Common Mistakes

- “Async reset이면 clock gating과 무관하다”고 생각한다.
- Clock force-on request를 실제 clock waveform와 혼동한다.
- Reset request 순간과 function reset completion을 같은 signal로 표현한다.
- Release chain의 F2 NBA와 function의 F2 normal operation을 같은 cycle로 센다.
- Clock resume 첫 edge부터 input ready를 올린다.
- Back-to-back reset을 우연히 coalesce하면서 software/event contract를 기록하지 않는다.
- Test enable을 functional enable에 raw logic로 결합한다.
- Function clock missing 상태의 liveness assumption을 숨긴다.

## 16. Verification Strategy

### Functional scenarios

- Reset accepted while function clock is running/stopped
- Reset and normal wake/request on the same root edge
- Clock force-on latency and missing-clock timeout
- Synchronous-reset active-edge count or async pulse width
- Release synchronization and first normal function edge
- Back-to-back reset: held, restart, coalesce or queue policy
- Reset during in-flight transaction and output invalidation
- Clock regating immediately after done
- Test/scan enable with reset assertion/release
- Independent peer-domain reset and stale status

### Assertions and liveness

- `reset_valid && !reset_ready` is not counted as accepted
- `reset_busy` blocks function acceptance
- Function reset is not released before clock availability and assertion completion
- Previous `function_reset_done_sync` high is cleared before waiting for a new completion
- `function_reset_done` only after local release and a normal function edge
- Accepted reset eventually reaches done **or** timeout, under explicit clock assumptions
- Clock can be regated only after synchronized done and normal policy handoff
- New reset request follows documented busy/restart policy

Clocked properties must state which clock owns each signal. Cross-domain end-to-end checks often need synchronized status, protocol monitors or a scoreboard rather than sampling raw signals in one SVA clock.

### Implementation evidence

- Clock-gating/ICG checks and generated-clock modeling
- Reset recovery/removal, pulse and release-chain checks
- CDC/RDC structural reports and waiver rationale
- DFT/scan controllability
- Post-route reset/clock tree and PPA

## 17. Design Review Checklist

- [ ] Function clock is provided by approved ICG/clock architecture, not raw logic?
- [ ] Root/always-on controller owns clock enable and reset sequencing?
- [ ] Reset request uses valid/ready/accept or another explicit event contract?
- [ ] Reset has priority over same-edge normal function acceptance?
- [ ] Clock availability is confirmed before required reset/release edges?
- [ ] Synchronous assertion edges or async pulse requirements are satisfied?
- [ ] Per-domain release chain and first normal edge are audited?
- [ ] Function reset-done is synchronized/handshaken back to root?
- [ ] Back-to-back reset and missing-clock policy are defined?
- [ ] Test/scan enable priority and clock controllability are reviewed?
- [ ] STA clock-gating, recovery/removal and RDC checks are active?
- [ ] Reset/wake/test overhead is included in PPA measurement?

## 관련 문서

- [Reset Architecture Overview](overview.md)
- [Synchronous vs Asynchronous Reset](sync_vs_async_reset.md)
- [Reset Deassertion and RDC](reset_deassertion.md)
- [Resetless Datapath](resetless_datapath.md)
- [Clock Design Overview](../06_clock/overview.md)
- [Clock Gating](../06_clock/clock_gating.md)
- [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)
- [CDC Overview](../08_cdc/overview.md)
