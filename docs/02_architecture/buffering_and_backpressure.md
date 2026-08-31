# Buffering and Backpressure

Buffer는 producer와 consumer 사이의 순간적인 rate 차이, burst와 stall propagation을 흡수한다. Buffer가 downstream resource의 지속 처리율을 새로 만들지는 않는다. 장기 input rate가 service rate보다 높으면 어떤 finite buffer도 결국 가득 찬다.

> Buffer depth는 throughput의 대체물이 아니다. Acceptance, consumption, capacity와 worst-case burst를 같은 protocol contract에서 계산한다.

Latency, throughput과 initiation interval의 공통 정의는 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md#3-latency-throughput-initiation-interval)를 따른다. 이 문서는 single-clock ready/valid storage와 backpressure를 다룬다. Asynchronous FIFO와 CDC coherency는 [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)가 담당한다.

## 1. Ready/Valid Event를 먼저 고정한다

```text
input acceptance  = in_valid  && in_ready  at active edge
output consumption = out_valid && out_ready at active edge
```

Producer 책임:

- `valid=1 && ready=0` 동안 payload와 transaction control을 안정적으로 유지한다.
- Handshake가 성립한 transaction만 전송 완료로 간주한다.

Consumer 책임:

- `valid=1 && ready=1`인 edge에서 payload를 consume한다.
- Ready를 내렸다면 producer가 output을 hold할 수 있음을 전제로 한다.

### Result available와 consumed

Buffer output에 `out_valid=1`이 되면 result는 available하다. `out_ready=0`이면 아직 consumed되지 않았으며 payload를 유지해야 한다.

```text
cycle              0       1       2       3
out_valid           0       1       1       1
out_ready           X       0       0       1
payload                     A       A       A
available                   A
consumed                                     A
```

계산 latency, queue waiting latency와 consumption latency를 구분한다. Backpressure가 있으면 end-to-end latency는 variable할 수 있다.

## 2. Buffer가 해결하는 것과 해결하지 않는 것

Buffer가 해결할 수 있는 것:

- 짧은 consumer stall 동안 transaction 보존
- Producer/consumer phase 차이
- Bounded burst 흡수
- Pipeline stage 사이의 local backpressure
- Combinational data path register boundary

Buffer가 해결하지 못하는 것:

- 지속적인 offered load > service capacity
- Incorrect latency/II architecture
- Missing arbitration bandwidth
- Unbounded downstream stall without flow-control contract
- CDC metastability/coherency
- Transaction drop을 허용하지 않는 interface의 overflow policy 부재

Queue depth를 늘리면 overflow 시점을 늦출 수 있지만 steady-state service rate는 consumer가 결정한다.

## 3. One-Entry Buffer, Register Slice, Skid Buffer, FIFO

| 구조 | Storage | 주요 목적 | 주의점 |
|---|---:|---|---|
| One-entry elastic buffer | 1 transaction | 한 stage hold, simultaneous consume/refill | ready path가 combinational일 수 있음 |
| Register slice | 보통 1개 이상 | data/valid 또는 ready timing 절단 | 구현에 따라 capacity/bypass semantics가 다름 |
| Skid buffer | main + skid entry | registered ready 뒤 한 cycle 늦은 backpressure 흡수 | 두 entry의 ownership/priority 검증 |
| Synchronous FIFO | 여러 entries | bounded burst/queueing | pointer, count, full/empty, ordering |
| Asynchronous FIFO | domain별 pointer/storage | CDC ordered transfer | synchronizer/Gray/reset/physical CDC 책임 |

`register slice`와 `skid buffer`라는 이름만으로 동작을 추정하지 않는다. Bypass 여부, latency, capacity, ready registration과 simultaneous enqueue/dequeue 규칙을 문서화한다.

## 4. One-Entry Elastic Buffer Hardware

이 문서의 예제는 bypass가 없는 single-clock one-entry buffer다.

```text
                 push                     pop
in_valid/data ─────┐                       │
                   ▼                       ▼
              [payload register + full bit] ──> out_valid/data
                   ▲
                   └──── hold while out_ready=0
```

상태는 한 bit `full_q`와 payload register다.

```text
normal operation: in_ready = empty OR output will be consumed now
                           = !full_q || out_ready
reset active:     in_ready = 0
```

Full 상태에서도 consumer가 현재 payload를 consume하는 edge에는 새 input을 동시에 accept해 entry를 refill할 수 있다. 이 기능이 없으면 매 transaction 사이에 bubble이 생겨 steady-state II가 2가 될 수 있다.

## 5. Cycle-Correct SystemVerilog

```systemverilog
module one_entry_elastic_buffer #(
    parameter int unsigned DATA_W = 16
) (
    input  logic                  clk,
    input  logic                  rst_n,
    input  logic                  in_valid,
    output logic                  in_ready,
    input  logic [DATA_W-1:0]     in_data,
    output logic                  out_valid,
    input  logic                  out_ready,
    output logic [DATA_W-1:0]     out_data
);
    logic              full_q;
    logic [DATA_W-1:0] data_q;
    logic              push;
    logic              pop;

    assign out_valid = full_q;
    assign out_data  = data_q;

    // A full entry can accept a replacement when the current item is consumed.
    assign in_ready = rst_n && (!full_q || out_ready);
    assign push     = in_valid && in_ready;
    assign pop      = out_valid && out_ready;

    // Event priority: reset > simultaneous push/pop > push > pop > hold.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            full_q <= 1'b0;
        end else begin
            unique case ({push, pop})
                2'b10: begin
                    data_q <= in_data;
                    full_q <= 1'b1;
                end
                2'b01: begin
                    full_q <= 1'b0;
                end
                2'b11: begin
                    data_q <= in_data;
                    full_q <= 1'b1;
                end
                default: begin
                    full_q <= full_q;
                end
            endcase
        end
    end
endmodule
```

`DATA_W`는 1 이상이라는 elaboration contract가 필요하다. `full_q=0`일 때 `data_q`는 invalid이므로 reset하지 않는다. `in_ready`를 `rst_n`으로 qualify했으므로 reset 중 `push=0`이고 input transaction이 accept되지 않는다. Reset release 뒤의 첫 active edge부터 normal ready/valid contract를 적용한다.

`default`의 self-assignment는 hold intent를 보여주기 위한 것이다. 생략해도 `always_ff` state는 hold할 수 있다. 실제 synthesis mapping은 enable-capable FF 또는 feedback selection 등 library/context에 따라 달라질 수 있다.

## 6. Simultaneous Enqueue and Dequeue Audit

| Current full | push | pop | Next full | Payload action |
|---:|---:|---:|---:|---|
| 0 | 0 | 0 | 0 | invalid/hold |
| 0 | 1 | 0 | 1 | capture input |
| 1 | 0 | 0 | 1 | hold current payload |
| 1 | 0 | 1 | 0 | current payload consumed |
| 1 | 1 | 1 | 1 | consume current, capture replacement |

Empty 상태에서는 `out_valid=0`이므로 `pop=1`일 수 없다. Full 상태에서 `out_ready=1`이면 `in_ready=1`이므로 replacement push가 가능하다.

### Cycle example

```text
edge                E0            E1            E2            E3
before state       empty          full A        full B        full B
in_valid/data       1/A           1/B           0             0
out_ready           0             1             0             1
push                1             1             0             0
pop                 0             1             0             1
after state         full A        full B        full B        empty
consumed                           A                           B
```

E1에서 nonblocking assignment는 edge 직전 `data_q=A`를 consumer에게 제공하면서, edge 뒤 `data_q=B`로 교체한다. A와 B가 같은 payload register를 사용하지만 ownership은 handshake edge에서 정확히 전환된다.

## 7. Bypass와 Latency

위 예제에는 empty combinational bypass가 없다. Empty buffer에 A가 push되면 A는 edge 뒤 stored output으로 available해진다. 장점은 input data path를 register로 끊는다는 것이고, 비용은 최소 한 register boundary다.

Fall-through/bypass FIFO는 empty일 때 input valid/data를 output으로 직접 전달할 수 있다.

```text
empty: input ──────────────> output
full:  storage register ───> output
```

이는 empty latency를 줄일 수 있지만 다음을 만든다.

- Input-to-output combinational data/valid path
- Out-ready에서 in-ready로 이어지는 path
- Empty/full 전환의 bypass/storage ownership
- Same-cycle consume와 store priority

Latency contract와 timing 목적이 명확하지 않다면 bypass를 추가하지 않는다.

## 8. Combinational Ready Path와 Registered Ready

위 one-entry buffer의 `in_ready = rst_n && (!full_q || out_ready)`는 normal operation에서 full일 때 downstream ready를 upstream으로 combinational 전달한다. 여러 stage를 연결하면 긴 ready chain이 생길 수 있다.

```text
downstream ready ─> stage N ─> ... ─> stage 1 ─> upstream ready
```

Ready를 단순히 register하면 backpressure가 한 cycle 늦게 producer에 도착한다. Producer는 직전 cycle의 ready를 보고 이미 transaction을 보낼 수 있으므로, 그 transaction을 저장할 추가 capacity가 없으면 drop 또는 overwrite가 발생한다.

### Skid capacity가 필요한 이유

```text
cycle N:   ready observed high, producer commits A
cycle N+1: registered ready becomes low
           A still arrives and needs a storage slot
```

Skid buffer는 이 late transaction을 잡을 보조 entry를 둔다. Correct registered-ready design은 다음을 함께 정의해야 한다.

- Main entry와 skid entry ownership
- Which entry drives output
- Simultaneous output consume, main refill와 skid capture
- Ready deassertion threshold
- No overwrite when both entries are occupied

추가 storage 없이 ready만 register하는 것은 timing optimization이 아니라 protocol violation 후보다.

## 9. FIFO Occupancy와 Capacity

Multi-entry synchronous FIFO에서는 count 또는 pointer state가 occupancy를 나타낸다.

```text
enqueue = in_valid && in_ready
dequeue = out_valid && out_ready

next_occupancy = occupancy
               + (enqueue ? 1 : 0)
               - (dequeue ? 1 : 0)
```

동시 enqueue/dequeue이면 occupancy는 유지되지만 read/write payload state는 모두 변할 수 있다. Full/empty flag만 보고 operation이 없다고 판단하면 안 된다.

Capacity contract:

- Legal occupancy range: `0..DEPTH`
- Enqueue when full: blocked, retry, drop 또는 error 중 하나
- Dequeue when empty: blocked 또는 protocol error
- Ordering: 일반적으로 FIFO order 유지
- Flush: queued entries 전부 폐기인지 selective cancel인지
- Reset: pointer/count/valid state의 compatible initialization

Pointer width와 extra wrap bit는 단순 area 여유분이 아니라 full/empty protocol 의미를 가질 수 있다. 자세한 width 판단은 [Bit-Width Minimization](../05_area/bit_width_minimization.md)을 참고한다.

## 10. Synthesis, STA와 Physical View

### Synthesis

One-entry buffer는 payload FF, valid/full FF와 ready/control logic으로 mapping될 수 있다. Wider payload와 reset 요구는 cell choice와 reset routing에 영향을 줄 수 있다. Small synchronous FIFO는 FF array 또는 memory structure로 mapping될 수 있으나 inference 조건과 target library에 의존한다.

### STA

주요 path:

- `out_ready → in_ready` combinational path
- `full_q → in_ready` control path
- Input payload → storage FF
- Storage FF → downstream combinational consumer
- Multi-entry pointer/count → full/empty → ready path

Ready chain이 timing critical이면 register slice/skid capacity, hierarchy partition과 local buffering을 검토한다.

### Physical

Wide payload buffer는 FF area뿐 아니라 clock/reset load와 routing track을 사용한다. Central FIFO가 distant producer/consumer 사이에 놓이면 long data/control routes가 생길 수 있다. Distributed shallow buffers는 locality를 개선할 수 있지만 total storage/control이 증가한다.

## 11. Timing, Power, Area Trade-off

| 선택 | Timing | Power | Area | Protocol impact |
|---|---|---|---|---|
| One-entry elastic | data path register 가능, ready path 잔존 | payload/full clock activity | payload FF + control | 1 transaction capacity |
| Registered ready + skid | ready path 절단 가능 | extra entry activity | additional payload/valid FF | late transaction 보존 |
| Deeper FIFO | burst isolation | pointer/memory activity | storage + pointers | queue latency 증가 |
| Bypass | empty latency 감소 | combinational switching | bypass MUX/control | combinational path 추가 |
| Distributed buffers | locality/ready partition | more clocked state | replicated storage | occupancy observability 복잡 |

Buffer를 추가한 뒤 block latency, clock power와 verification state space가 늘 수 있다. 동일 traffic workload와 constraint에서 비교한다.

## 12. 적용하면 안 되는 경우

- 지속 input rate가 service capacity보다 높은 문제를 depth만 늘려 해결하려는 경우
- Ready가 없는 source 앞에 lossless buffer를 두면서 overflow policy가 없는 경우
- Ready를 register하고 late transaction용 storage를 추가하지 않는 경우
- Output stall 중 payload를 변경하는 경우
- FIFO count width를 줄이면서 `DEPTH` occupancy 표현을 잃는 경우
- Synchronous FIFO RTL을 asynchronous clock domains에 그대로 사용하는 경우
- Flush가 selective인지 global인지 정의하지 않고 queue state를 clear하는 경우

## 13. Common Mistakes

### Buffer가 throughput을 높인다고 말한다

Burst throughput과 sustainable service rate를 혼동한다.

### Available과 consumed를 같은 event로 본다

Output valid 뒤 ready stall 시간을 latency에서 빠뜨리거나 payload hold를 위반한다.

### Simultaneous push/pop에서 entry를 empty로 만든다

Current item은 consume되지만 replacement input이 같은 edge에 capture되므로 next state는 full이다.

### Full일 때 ready를 무조건 0으로 만든다

Simultaneous consume/refill을 막아 unnecessary bubble을 만든다. Interface timing 목적상 의도한 선택이면 II 비용을 명시한다.

### Empty/full만 검증하고 ordering을 놓친다

Drop/duplicate/reorder는 occupancy 범위가 정상이어도 발생할 수 있다.

### 모든 payload FF를 reset한다

Valid/full이 invalid data를 mask하는데 payload reset을 추가하면 reset routing/area가 늘 수 있다. Safety/test/X policy가 요구할 때만 적용한다.

## 14. Verification Strategy

### Local invariants

```systemverilog
ap_output_stable_while_blocked:
    assert property (@(posedge clk) disable iff (!rst_n)
        (out_valid && !out_ready) |=>
            (out_valid && $stable(out_data))
    );

ap_empty_cannot_pop:
    assert property (@(posedge clk) disable iff (!rst_n)
        !out_valid |-> !pop
    );

ap_reset_blocks_input:
    assert property (@(posedge clk)
        !rst_n |-> (!in_ready && !push)
    );
```

No-drop/no-duplicate/ordering은 payload tag 또는 verification-only sequence number를 사용해 accepted queue와 consumed queue를 비교하는 편이 명확하다.

### Corner matrix

- Empty push, full hold, pop only
- Full simultaneous push+pop
- Back-to-back traffic with ready always high
- Long downstream stall with valid held
- Reset 중 `in_valid=1`이어도 no-accept인지, empty/full reset과 release 직후 traffic
- Payload min/max, alternating patterns와 X policy
- FIFO wrap-around, full-to-simultaneous pop/push, empty boundary
- Flush with queued transactions

### End-to-end properties

- Every accepted item is consumed at most once.
- Every consumed item was previously accepted.
- Accepted order equals consumed order.
- Blocked output remains stable.
- Occupancy never leaves `0..capacity`.
- Under fairness assumptions, accepted items eventually progress.

Liveness는 downstream ready fairness가 없으면 증명할 수 없다. Assumption을 property와 review record에 명시한다.

## 15. Design Review Checklist

### Contract

- [ ] Acceptance, available와 consumption event가 구분됐는가?
- [ ] Fixed calculation latency와 variable queueing latency를 구분했는가?
- [ ] Sustainable rate와 bounded burst가 정의됐는가?
- [ ] Overflow, underflow, drop/retry와 flush policy가 있는가?

### Structure

- [ ] Buffer capacity와 bypass semantics가 명확한가?
- [ ] Simultaneous enqueue/dequeue next state가 정확한가?
- [ ] Full/empty와 occupancy width가 `0..DEPTH`를 표현하는가?
- [ ] Ready를 register한다면 late transaction을 저장할 capacity가 있는가?
- [ ] Reset 중 ready/push가 낮고 reset release acceptance가 명확한가?
- [ ] Stall 중 valid/payload/control이 함께 hold되는가?

### Evidence

- [ ] No-drop/no-duplicate/ordering scoreboard 또는 assertions가 있는가?
- [ ] Blocked-output stability가 검증됐는가?
- [ ] Ready path timing과 payload path timing을 모두 확인했는가?
- [ ] Storage, pointer, reset, clock와 routing area를 포함했는가?
- [ ] Representative burst/backpressure workload에서 occupancy를 측정했는가?
- [ ] CDC가 있다면 synchronous FIFO와 별도 CDC architecture를 사용했는가?

## 관련 문서

- [Latency, Throughput and Initiation Interval](latency_throughput_ii.md)
- [State Partitioning and Ownership](state_partitioning_and_ownership.md)
- [Requirement to Microarchitecture](requirement_to_microarchitecture.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)
- [Bit-Width Minimization](../05_area/bit_width_minimization.md)
