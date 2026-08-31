# State Partitioning and Ownership

State partitioning은 register를 여러 `always_ff` block에 나누는 coding style 문제가 아니다. 어떤 정보가 얼마나 오래 살아 있고, 누가 갱신하며, 어느 event에서 invalid가 되고, 어디서 관찰되는지를 architecture로 정하는 일이다.

> State owner가 없으면 simultaneous event의 우선순위, reset/flush 범위와 evidence owner도 없다. State를 나누되 transaction consistency가 끊어지지 않게 한다.

State와 sequential logic의 canonical 의미는 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md)와 [Combinational vs Sequential Logic](../01_fundamentals/combinational_vs_sequential.md)을 따른다. 이 문서는 **lifetime, ownership, atomicity와 boundary**를 다룬다.

## 1. State 종류를 구분한다

| 종류 | 예 | Lifetime | Invalid/reset 질문 |
|---|---|---|---|
| Persistent architectural state | configuration, mode, committed counter | transaction보다 길다 | reset/default와 software-visible 의미 |
| Transaction/in-flight state | captured operands, tag, mode snapshot | accept부터 complete/cancel까지 | flush/cancel/stall 처리 |
| Protocol/control state | valid, busy, pointer, FSM, credit | protocol phase 동안 | legal transition과 recovery |
| Derived/cache state | predecode, cached parity, replicated status | source state에 종속 | source change 시 invalidation/coherency |
| Datapath payload state | pipeline data, uncommitted result | corresponding valid lifetime | resetless 가능 여부 |

같은 register가 여러 역할을 겸하면 review가 어려워진다. 예를 들어 `count_q`가 transaction progress이면서 external status라면 flush와 software read가 충돌할 수 있다.

## 2. State Inventory

RTL 전에 다음 표를 만든다.

| State | Semantic owner | Writer | Update event | Lifetime | Observation | Invalidation |
|---|---|---|---|---|---|---|
| `mode_q` | configuration | config interface | accepted config write | reset→next write | transaction capture/status | reset |
| `txn_payload_q` | current transaction | input stage | load/accept | accept→complete/clear | datapath | `txn_valid_q=0` |
| `txn_mode_q` | transaction metadata | input stage | same load as payload | transaction lifetime | result stage | `txn_valid_q=0` |
| `progress_q` | sequencer | control owner | advance | transaction lifetime | control/complete | clear/complete |
| `last_step` | derived combinational state | no independent writer | from progress | same cycle | control | source changes |

“Writer”는 RTL block 위치이고 “semantic owner”는 requirement 책임이다. 한 block이 여러 state를 쓸 수 있지만 각 state의 update event와 lifetime은 분리해 기록한다.

## 3. Single Writer와 Atomic Update

하나의 register를 여러 procedural block에서 쓰지 않는 것은 기본이다. 더 중요한 것은 **서로 한 transaction을 구성하는 여러 registers가 하나의 atomic event로 갱신되는가**이다.

```text
accept transaction A
    ├─ payload_q      <= A.payload
    ├─ mode_q_snapshot<= A.mode
    ├─ tag_q          <= A.tag
    └─ valid_q        <= 1
```

Payload만 load되고 tag가 stall 때문에 hold되면 state 각각은 합법적인 값이어도 transaction 전체는 incoherent하다.

Atomicity 질문:

- Same accept edge에 함께 capture되는가?
- Stall/clock enable이 모두 같은 조건인가?
- Flush가 valid만 clear해 stale payload를 mask하는가, payload도 실제 의미상 clear해야 하는가?
- Config write와 transaction accept가 동시에 오면 old/new config 중 무엇을 snapshot하는가?
- Completion과 refill이 같은 edge에 가능한가?

## 4. Control과 Datapath를 나누는 이유

Control/valid를 좁고 명확한 state로 두면 다음 장점이 있다.

- Payload가 invalid일 때 reset/clear를 생략할 수 있음
- Stall/flush semantics를 valid state로 표현
- Formal invariant와 state-space reasoning이 명확함
- Wide datapath의 unnecessary switching/reset routing 감소 가능

하지만 과도하게 분할하면 cross-coupling이 생긴다.

```text
control block ── enables/selects ──> datapath block
      ▲                                  │
      └──── done/error/status feedback ──┘
```

Hierarchy를 나눴다고 timing path나 ownership이 사라지지 않는다. Late enable, status fanout와 combinational loop가 생길 수 있다. Block 경계는 protocol과 physical locality에 맞춰 정한다.

## 5. Generic RTL: Persistent Config와 Transaction State

다음 예제는 transaction request와 accepted event를 구분한다.

```text
load_accept = load_valid && load_ready
```

- Persistent `mode_q`는 config owner가 갱신한다.
- `load_accept`는 payload와 effective mode를 atomic capture한다.
- Config write와 transaction load가 같은 edge면 새 config를 transaction이 사용한다.
- Reset 또는 clear 중에는 `load_ready=0`이므로 request가 accept되지 않는다.
- 이 illustrative example에서는 active transaction 중 accepted load가 명시적인 replacement/preemption이며 load가 advance보다 우선한다.
- Transaction event priority: clear → accepted load → advance → hold.
- `advance`가 last step에서 발생하면 transaction이 complete되어 valid가 clear된다.

```systemverilog
module owned_transaction_state (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        cfg_write,
    input  logic [1:0]  cfg_mode,
    input  logic        clear_txn,
    input  logic        load_valid,
    output logic        load_ready,
    input  logic        advance_txn,
    input  logic [15:0] load_payload,
    output logic        txn_active,
    output logic [15:0] txn_payload,
    output logic [1:0]  txn_mode,
    output logic [1:0]  txn_step
);
    logic [1:0]  mode_q;
    logic        txn_valid_q;
    logic [15:0] txn_payload_q;
    logic [1:0]  txn_mode_q;
    logic [1:0]  progress_q;
    logic [1:0]  effective_mode;
    logic        load_accept;

    assign effective_mode = cfg_write ? cfg_mode : mode_q;
    assign load_ready      = rst_n && !clear_txn;
    assign load_accept     = load_valid && load_ready;
    assign txn_active      = txn_valid_q;
    assign txn_payload     = txn_payload_q;
    assign txn_mode        = txn_mode_q;
    assign txn_step        = progress_q;

    // Global priority: reset first.
    // Transaction priority: clear > accepted load > advance > hold.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            mode_q      <= 2'd0;
            txn_valid_q <= 1'b0;
            progress_q  <= 2'd0;
        end else begin
            if (cfg_write)
                mode_q <= cfg_mode;

            if (clear_txn) begin
                txn_valid_q <= 1'b0;
                progress_q  <= 2'd0;
            end else if (load_accept) begin
                txn_valid_q   <= 1'b1;
                txn_payload_q <= load_payload;
                txn_mode_q    <= effective_mode;
                progress_q    <= 2'd0;
            end else if (advance_txn && txn_valid_q) begin
                if (progress_q == 2'd2) begin
                    txn_valid_q <= 1'b0;
                    progress_q  <= 2'd0;
                end else begin
                    progress_q <= progress_q + 2'd1;
                end
            end
        end
    end
endmodule
```

`effective_mode`는 same-edge `cfg_write + load_accept`에서 새 `cfg_mode`를 capture하도록 명시한다. 이를 쓰지 않고 `txn_mode_q <= mode_q`로 작성하면 nonblocking semantics 때문에 old mode가 capture된다. 어느 동작이 맞는지는 requirement가 정해야 한다.

Active transaction 중 `load_accept`가 발생하면 old transaction은 preempt되고 new payload가 step 0에서 owner가 된다. Preemption이 허용되지 않는 block은 `load_ready`를 `!txn_valid_q` 또는 legal completion/refill condition으로 추가 qualify하고, rejected request를 accept로 세지 않아야 한다.

Payload와 transaction mode registers는 `txn_valid_q=0`일 때 architecturally invalid이므로 reset하지 않는다. `progress_q`는 control observation과 recovery를 단순화하기 위해 reset/clear한다. Safety, test 또는 X-propagation requirement가 다르면 reset 선택도 달라질 수 있다.

## 6. Simultaneous Event Cycle Audit

초기 상태는 `mode=0`, inactive다.

```text
edge                     E0              E1          E2                E3
cfg_write/mode           1/2             0           0                 0
clear/load_valid/advance 0/1/0           0/0/1       1/1/1             0/1/1
load_ready/accept        1/1             1/0         0/0               1/1
mode after edge          2               2           2                 2
txn after edge           P0, mode2       P0 step1    inactive          P3, mode2 step0
winning event            accepted load   advance     clear             accepted load
```

- E0: Config write와 accepted load가 동시에 일어나며 `effective_mode=2`가 transaction에 snapshot된다.
- E2: Clear와 `load_valid`이 동시에 high이지만 `load_ready=0`, `load_accept=0`이다. New payload는 accept되지 않고 clear가 old transaction을 폐기한다.
- E3: `load_accept=1`이므로 accepted load가 advance보다 우선해 new transaction이 step 0에서 시작한다.

이 예제의 replacement/preemption은 의도된 contract다. Lossless non-preemptive interface에서는 active transaction completion 전 `load_ready`를 낮추거나 추가 buffer로 request를 보존해야 한다.

## 7. State Lifetime과 Observation Point

State가 내부에 존재하는 것과 외부에서 의미가 있는 것은 다르다.

```text
payload register has bits ─────── always physically present
payload is architecturally valid ─ only while corresponding valid=1
```

Observation point를 기록한다.

- Status register가 in-flight progress를 읽는가?
- Debug/test가 invalid payload 값을 요구하는가?
- Error logic가 valid 없이 datapath state를 관찰하는가?
- Power gating 전 retention 대상인가?
- Formal property가 X payload를 잘못 constraint하는가?

Invalid data가 어디에서도 사용되지 않는다는 evidence가 있을 때만 resetless payload가 안전한 후보가 된다. Functional observer와 X contract는 [Resetless Datapath](../07_reset/resetless_datapath.md), pipeline 적용은 [Pipeline Design](../03_timing/pipeline.md#9-reset-strategy), low-power 영향은 [Low-Power RTL Design](../04_low_power/overview.md)을 참고한다.

## 8. Always-On State와 Function-Clock State

Function clock이 멈춘 뒤 그 clock domain 내부 state만으로 wake-up을 결정하면 self-deadlock이 생길 수 있다.

```text
always-on/root-clock state
    ├─ wake request capture
    ├─ clock enable ownership
    └─ reset/power transition control

function-clock state
    ├─ datapath progress
    └─ local transaction state
```

Wake source, clock enable와 minimum always-on state는 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)과 [Clock Gating](../06_clock/clock_gating.md)이 canonical하게 다룬다. State partition 문서에서는 owner와 lifetime을 표시하고 clock architecture를 재정의하지 않는다.

## 9. Duplicated, Shadow와 Cached State

State duplication은 fanout/locality 또는 availability를 개선할 수 있지만 coherency contract가 필요하다.

### Derived replica

Source state에서 다시 계산 가능한 decode/cache다. Source update와 same edge에 갱신하거나 valid/version으로 stale 상태를 차단한다.

### Shadow configuration

Active state와 software-programmable shadow state를 분리하고 commit event에 atomic swap할 수 있다. Partial write와 commit priority를 정한다.

### Replicated architectural state

두 copies가 각각 독립 writer를 가지면 divergence 위험이 크다. Single source of truth, broadcast update, comparison/recovery 또는 explicit partition ownership이 필요하다.

확인 항목:

- Which copy is authoritative?
- Update loss/reorder가 가능한가?
- Reset/mode transition에서 version이 일치하는가?
- Consumer가 서로 다른 copies를 동시에 관찰할 수 있는가?
- Physical duplication이 functional RTL state를 늘리는가, tool buffer/replica에 그치는가?

## 10. Mode Transition과 Atomicity

Mode가 바뀔 때 in-flight transaction에 old/new mode 중 무엇을 적용하는지 정한다.

가능한 contract:

- Accept 때 mode snapshot: in-flight는 old mode로 완료
- Drain then switch: pipeline empty 뒤 active mode 변경
- Flush then switch: old transactions 폐기
- Version tag: old/new transactions 동시 존재

Mode signal을 live combinational control로 모든 stage에 뿌리면 transaction 중간에 semantics가 바뀌고 fanout timing도 악화될 수 있다. Snapshot 또는 protocolized transition이 더 명확할 수 있지만 state/area가 증가한다.

## 11. CDC와 RDC Boundary

State ownership이 clock/reset domain을 넘으면 single-writer만으로 충분하지 않다.

- Source domain state와 destination representation을 구분한다.
- Synchronizer output은 source register의 동일 physical state가 아니라 sampled representation이다.
- Multi-bit state는 coherency protocol이 필요하다.
- Independent reset은 stale valid, phantom transaction 또는 divergence를 만들 수 있다.

CDC 구조는 [CDC Overview](../08_cdc/overview.md), multi-bit coherency는 [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)를 따른다. RDC 전용 문서가 추가되기 전에는 reset-domain assumption을 decision record와 review checklist에 명시한다.

## 12. Synthesis, STA와 Physical View

### Synthesis

State partition은 FF banks, enable/reset MUX, decode와 fanout 구조에 영향을 준다. Payload reset을 제거하면 resettable cell/reset routing이 줄 가능성이 있지만 mapping은 library/flow에 의존한다. Derived state는 tool이 다시 계산하거나 sharing/duplication할 수 있다.

### STA

주요 path:

- Persistent config → transaction capture MUX
- Control state → wide datapath enable/select
- Datapath done/error → control next state
- Mode/clear/flush high-fanout paths
- Shadow commit → multiple state banks

Control/datapath hierarchy가 분리돼도 path는 사라지지 않는다.

### Physical

Local state snapshot은 long global control route를 줄일 수 있지만 FF/clock/reset load를 늘린다. Central state는 copies를 줄이지만 fanout/buffering/congestion을 키울 수 있다. Post-route evidence로 partition을 보정한다.

## 13. Timing, Power, Area Trade-off

| 선택 | Timing | Power | Area | Verification |
|---|---|---|---|---|
| Local state snapshot | fanout/locality 개선 가능 | local FF activity | state 복제 | snapshot alignment |
| Central owner | update atomicity 단순 | central net switching | copies 감소, buffers 증가 가능 | arbitration/priority |
| Resetless payload | reset path 감소 가능 | reset switching 감소 | cell/routing 감소 가능 | valid/X discipline |
| Derived cache | critical decode 단축 가능 | cache update activity | extra FF/logic | coherency/invalidation |
| Drain-before-mode | transition 단순 | idle drain cost | little extra state | progress/deadlock |

정량 결과는 target cells, fanout, activity, floorplan과 reset methodology에 따라 달라진다.

## 14. 적용하면 안 되는 경우

- Live mode가 in-flight transaction을 바꿔도 된다는 evidence 없이 global control로 사용하는 경우
- Payload reset을 제거하면서 valid 없는 observer가 남는 경우
- Duplicated state에 authoritative owner와 coherency protocol이 없는 경우
- Function clock이 off인데 function state가 wake enable을 소유하는 경우
- CDC bus를 independent sampled copies로 만들고 coherent state라고 부르는 경우
- Clear/load-request/advance priority와 accept qualification을 code ordering에 맡기는 경우
- Control/datapath를 지나치게 분할해 combinational dependency loop를 만드는 경우

## 15. Common Mistakes

### Register 목록을 state inventory라고 부른다

Lifetime, writer, observation과 invalidation이 빠져 있다.

### Valid만 control이고 payload는 state가 아니라고 생각한다

Payload도 transaction lifetime 동안 보존되는 state다. 다만 reset requirement가 다를 수 있다.

### Same edge config update의 old/new semantics를 우연에 맡긴다

Nonblocking assignment 때문에 예상과 다른 version을 snapshot할 수 있다.

### Physical replica를 functional owner로 오해한다

Tool-created buffering과 RTL-visible duplicated state의 coherency 책임은 다르다.

### 모든 state에 같은 reset/clock policy를 적용한다

Always-on control, function datapath와 invalid payload의 requirement가 다르다.

## 16. Verification Strategy

### Invariants

- `txn_active=0`이면 transaction payload/mode를 architectural consumer가 사용하지 않는다.
- `load_accept`만 payload, mode와 valid를 atomic하게 갱신한다.
- Reset/clear 중 `load_ready=0`이며 `load_valid`만으로 transaction을 세지 않는다.
- Clear가 load-valid/advance와 동시에 오면 ready/accept와 documented winner가 일치한다.
- Config write + load-accept semantics가 old/new version contract와 일치한다.
- Progress는 active transaction에서만 advance한다.
- Duplicated derived state는 source version과 일치하거나 invalid다.

### Corner matrix

- Clear/load-valid/advance의 모든 simultaneous 조합과 `load_ready/load_accept`
- Config write + accepted load
- Completion + new load
- Reset/flush during each progress step
- Back-to-back transactions와 mode change
- Clock stop/wake와 pending request
- Independent domain reset ordering

Reference model은 raw register values보다 accepted events, mode version과 transaction lifetime을 추적한다.

## 17. Design Review Checklist

### Inventory와 ownership

- [ ] Persistent, transaction, protocol, derived와 payload state를 분류했는가?
- [ ] 각 state의 semantic owner, writer, update event와 lifetime이 있는가?
- [ ] Observation point와 invalidation/reset/flush rule이 있는가?
- [ ] Same transaction state가 atomic하게 advance/hold되는가?

### Boundaries

- [ ] Control/datapath partition이 late path나 combinational loop를 만들지 않는가?
- [ ] Always-on/root-clock state가 wake와 clock enable을 소유하는가?
- [ ] Resetless payload가 valid와 모든 observers로 안전하게 mask되는가?
- [ ] CDC/RDC boundary에서 source state와 destination representation을 구분했는가?

### Simultaneous events와 replicas

- [ ] Clear/load-valid/advance와 config/load-accept priority가 requirement에 있는가?
- [ ] Request와 accepted event를 구분하고 replacement/preemption 허용 여부를 명시했는가?
- [ ] Mode transition이 snapshot, drain, flush 또는 version 방식으로 정의됐는가?
- [ ] Shadow/duplicated/cache state의 authoritative source와 invalidation이 있는가?
- [ ] Post-route fanout/locality 이득과 state/clock/reset cost를 비교했는가?
- [ ] Change trigger가 owner/evidence 문서에 연결됐는가?

## 관련 문서

- [Requirement to Microarchitecture](requirement_to_microarchitecture.md)
- [Buffering and Backpressure](buffering_and_backpressure.md)
- [Microarchitecture Decision Record](microarchitecture_decision_record.md)
- [Feedback Dependency](feedback_dependency.md)
- [Unused Logic and State Reduction](../05_area/unused_logic_and_state_reduction.md)
- [Reset Area Cost](../05_area/reset_area_cost.md)
- [Reset Architecture Overview](../07_reset/overview.md)
- [Resetless Datapath](../07_reset/resetless_datapath.md)
- [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)
- [CDC Overview](../08_cdc/overview.md)
- [FSM Design](../09_control_logic/fsm_design.md)
