# Latency, Throughput and Initiation Interval

Latency가 짧은 block이 반드시 높은 throughput을 내는 것은 아니며, 긴 pipeline이 반드시 느린 것도 아니다. Microarchitecture를 정하려면 transaction 한 건의 이동 시간, 새 transaction을 받는 간격, steady-state 완료율을 서로 분리해 schedule로 표현해야 한다.

> “빠르다”를 architecture requirement로 사용하지 않는다. Accept edge, completion event, latency, initiation interval, clock frequency와 response deadline을 각각 적는다.

용어의 authoritative definition은 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md#3-latency-throughput-initiation-interval)에 있다. 이 문서는 정의를 다시 만드는 대신, 세 metric을 cycle schedule, handshake와 hardware resource 결정에 적용하는 방법을 다룬다.

## 1. 왜 세 Metric이 모두 필요한가

다음 두 block은 한 transaction의 결과가 나오는 시간이 비슷해도 traffic 처리 능력이 다르다.

```text
Fully pipelined

cycle        0    1    2    3    4    5
accept       A    B    C    D
complete               A    B    C    D

Iterative shared unit

cycle        0    1    2    3    4    5    6    7
accept       A                   B
busy         A    A    A         B    B    B
complete               A                   B
```

첫 구조는 여러 transaction이 서로 다른 stage에 동시에 존재한다. 두 번째 구조는 하나의 resource와 feedback state를 transaction이 독점한다. “둘 다 결과에 3 cycle이 걸린다”만 기록하면 queue depth, backpressure와 system throughput을 설계할 수 없다.

## 2. Metric을 Interface Event에 고정한다

Cycle 수를 세기 전에 시작과 끝 event를 고정한다.

```text
accept   := in_valid && in_ready sampled at rising edge
complete := out_valid && out_ready sampled at rising edge
```

`out_ready`가 없는 interface에서는 `out_valid` assertion을 completion으로 정의할 수 있다. Ready/valid interface에서는 다음을 구분해야 한다.

- **Result available:** producer가 `out_valid`와 payload를 제시한 시점
- **Transaction consumed:** `out_valid && out_ready`가 성립한 시점

Downstream backpressure 때문에 둘 사이가 벌어질 수 있다. Block 내부 계산 latency와 end-to-end queueing latency를 같은 숫자로 섞지 않는다.

이 문서의 `result available at E0 + L`은 [canonical convention](../01_fundamentals/terminology.md#3-latency-throughput-initiation-interval)에 따라 downstream sequential consumer나 concurrent SVA가 해당 edge의 preponed sample에서 matching valid/data를 관찰할 수 있다는 뜻이다. Producer output register가 바로 전 edge의 NBA 뒤 값을 publish한 시점과 이 synchronous observation edge를 구분한다.

### Fixed latency contract

```text
accept at E0  → result available at E0 + L
```

모든 accepted transaction에 같은 `L`이 적용된다. Bubble이 있어도 뒤 transaction이 앞 transaction을 추월하지 않는지 별도로 명시한다.

### Variable latency contract

Cache miss, iterative early exit, arbitration 또는 backpressure가 있으면 latency가 달라질 수 있다.

```text
minimum latency   = protocol상 가장 빠른 completion
maximum latency   = bounded response가 있다면 그 상한
ordering          = in-order or out-of-order
progress condition = downstream ready / grant / memory response assumption
```

평균 latency만으로 deadlock, timeout과 buffer sizing을 검증할 수 없다. Bound가 없다면 어떤 fairness 또는 environment assumption에서 progress를 기대하는지 적는다.

## 3. Cycle Schedule을 먼저 그린다

Microarchitecture 후보마다 작은 schedule table을 그리면 hidden serialization을 빠르게 찾을 수 있다.

### 3.1 II=1 feed-forward pipeline

```text
edge          E0    E1    E2    E3    E4
accept         A     B     C
stage 0        A     B     C
stage 1              A     B     C
output valid                     A     B     C
```

각 stage가 매 cycle advance할 수 있고 stall이 없다면 latency가 여러 cycle이어도 II=1이 가능하다. Pipeline stage 설계와 balancing은 [Pipeline Design](../03_timing/pipeline.md)이 담당한다.

### 3.2 Single-resource iterative schedule

```text
edge          E0    E1    E2    E3    E4    E5    E6    E7
accept         A                       B
iteration      A0    A1    A2          B0    B1    B2
output valid               A                       B
```

Resource가 한 transaction의 state를 완료까지 보존하고 E3에는 새 input을 동시에 capture하지 못한다면 A와 B의 accept 간격은 4 cycle이다. 같은 연산 latency라도 completion과 acceptance를 겹칠 수 있게 double-buffering하면 II가 달라질 수 있다.

### 3.3 Multi-lane structure

```text
             ┌─ lane 0 ─┐
input issue ─┤          ├─ completion merge
             └─ lane 1 ─┘
```

두 lane이 각각 II=1이면 이상적인 issue capacity는 cycle당 두 transaction일 수 있다. 하지만 input arbitration, output merge, ordering, shared memory port가 병목이면 실제 sustainable throughput은 더 낮다.

## 4. Throughput은 Clock Frequency와 함께 본다

Stall이 없고 한 개 issue lane이 매 `II` cycle마다 input을 accept한다면 최대 accept rate의 단순 상한은 다음처럼 생각할 수 있다.

```text
transactions per second ≈ clock frequency / II
```

여러 독립 lane이면 lane 수가 곱해질 수 있지만, shared interface와 workload가 이를 공급하고 소비할 수 있어야 한다. 이 관계는 capacity model이지 실제 workload throughput의 보장이 아니다.

예를 들어 II를 2에서 1로 줄이기 위해 logic을 크게 복제했지만 target frequency가 routing 때문에 낮아지면 초당 throughput 이득이 기대보다 작을 수 있다. 반대로 낮은 frequency에서도 II=1인 구조가 system deadline을 만족할 수 있다.

Review에서는 다음을 함께 기록한다.

- Target/achieved clock frequency
- Accepted transactions per cycle
- Completed transactions per cycle
- Workload의 valid/bubble 분포
- Downstream backpressure 비율
- Burst 길이와 queue occupancy

## 5. II를 제한하는 Hardware 원인

### Resource occupancy

한 multiplier, memory port 또는 output bus를 transaction이 여러 cycle 점유하면 다음 input issue가 막힐 수 있다.

### Feedback dependency

```text
state[n] ── update function ──> state[n+1]
   ▲                              │
   └──────────────────────────────┘
```

다음 iteration이 이전 결과에 의존하면 combinational path만 나누는 pipeline이 iteration II를 자동으로 줄이지 않는다. Interleaving할 독립 context, look-ahead 또는 algorithm 변경이 필요할 수 있다. Dependency distance와 legal transformation은 [Feedback Dependency](feedback_dependency.md)를 참고한다.

### Arbitration과 ports

Operator가 여러 개여도 single-port memory, one-result-per-cycle output 또는 central arbiter가 serialization point가 될 수 있다.

### Control recovery

Flush, exception, mode change 후 재시작 penalty도 effective II와 throughput에 영향을 준다. Nominal schedule만으로 burst traffic을 평가하지 않는다.

### Backpressure propagation

Elastic pipeline의 downstream stall이 upstream ready를 낮추면 순간적인 II가 길어진다. Long combinational ready chain은 timing path 자체가 될 수 있으므로 skid buffer 또는 registered boundary가 필요할 수 있다.

## 6. RTL Example: 명시적인 Iterative Schedule

다음 block은 네 개의 unsigned 8-bit 값을 하나의 10-bit adder/accumulator 경로로 합산한다.

- Accept 조건: `in_valid && in_ready`
- Accept edge를 `E0`라고 할 때 output register publication: E3 NBA 뒤
- Matching output valid/data의 첫 synchronous observation/capture: E4
- Interface latency: 4 cycle
- 현재 구현의 II: 4 cycle
- Reset 우선순위: reset이 busy transaction과 output valid를 폐기
- Busy 중 input은 accept하지 않음

```systemverilog
module iterative_sum4 (
    input  logic       clk,
    input  logic       rst_n,
    input  logic       in_valid,
    output logic       in_ready,
    input  logic [7:0] in_x0,
    input  logic [7:0] in_x1,
    input  logic [7:0] in_x2,
    input  logic [7:0] in_x3,
    output logic       out_valid,
    output logic [9:0] out_sum
);
    logic       busy_q;
    logic [1:0] step_q;
    logic [9:0] accum_q;
    logic [7:0] x1_q;
    logic [7:0] x2_q;
    logic [7:0] x3_q;

    // Reset 중에는 upstream에 acceptance를 광고하지 않는다.
    assign in_ready = rst_n && !busy_q;

    // Event priority: reset > busy iteration > idle accept/hold.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            busy_q    <= 1'b0;
            step_q    <= 2'd0;
            out_valid <= 1'b0;
        end else begin
            out_valid <= 1'b0;

            if (busy_q) begin
                case (step_q)
                    2'd0: begin
                        accum_q <= accum_q + {2'b00, x1_q};
                        step_q  <= 2'd1;
                    end
                    2'd1: begin
                        accum_q <= accum_q + {2'b00, x2_q};
                        step_q  <= 2'd2;
                    end
                    default: begin
                        out_sum   <= accum_q + {2'b00, x3_q};
                        out_valid <= 1'b1;
                        busy_q    <= 1'b0;
                        step_q    <= 2'd0;
                    end
                endcase
            end else if (in_valid) begin
                accum_q <= {2'b00, in_x0};
                x1_q    <= in_x1;
                x2_q    <= in_x2;
                x3_q    <= in_x3;
                busy_q  <= 1'b1;
                step_q  <= 2'd0;
            end
        end
    end
endmodule
```

네 개의 8-bit unsigned 값을 더한 최대값은 1020이므로 10-bit output이 필요하다. 각 operand를 10-bit로 명시적으로 zero-extend하여 expression width를 분명히 했다.

E0에서 request를 accept한 뒤 E1과 E2에서 중간 덧셈을 수행하고, E3 edge의 NBA 뒤 `out_sum`과 `out_valid`을 publish한다. E3의 downstream FF와 concurrent SVA는 이미 이전 값을 sampling했으므로 matching output을 처음 synchronous하게 관찰·capture하는 edge는 E4다. 따라서 interface latency는 4 cycle이고 resource가 E3 completion edge에 새 request를 함께 받지 않으므로 II도 4다.

Reset assertion 중 `in_ready`를 0으로 강제하지 않으면 upstream은 request가 accept됐다고 판단하지만 sequential reset branch가 그 request를 폐기할 수 있다. 이 예의 reset contract는 “reset 중 acceptance 없음”이며, reset deassertion 정책은 integration의 reset synchronization rule과 함께 결정한다.

E3 output-register publication edge 직전에는 `busy_q == 1`이므로 새 input을 E3에 accept하지 않는다. E3 NBA 뒤에는 `busy_q == 0`과 `out_valid == 1`이 되어, E4에서 downstream이 A를 synchronous하게 소비하는 동시에 upstream이 B를 accept할 수 있다. Result capture와 새 input refill을 E3에 겹치려면 `in_ready` 정의, operand capture와 busy update priority를 바꾸고 동시 event를 검증해야 한다. 단순히 `in_ready`를 일찍 올리면 진행 중 state가 덮어써질 수 있다.

## 7. 다른 Architecture 후보와 비교

같은 sum-of-four 기능을 여러 방식으로 구현할 수 있다.

| 후보 | 예시 schedule | Timing | Power | Area | 주요 조건 |
|---|---|---|---|---|---|
| Combinational adder tree | low latency, II=1 가능 | tree depth와 routing 확인 | input 변화마다 activity | adders 복수 | clock period 안에 완료 |
| Pipelined tree | latency 증가, II=1 가능 | stage 분할 가능 | FF clock power 증가 | adders+FF | transaction alignment |
| Iterative accumulator | latency/II 증가 | feedback adder path | 한 adder를 여러 cycle 사용 | adder 감소, state/control 증가 | throughput 허용 |
| Multiple iterative lanes | latency 유지, aggregate II 개선 | arbiter/merge path | lane activity 증가 | state/resource 복제 | ordering과 locality |

Operator 개수만으로 area를 단정하지 않는다. Iterative 구조에는 operand storage, step counter, busy/valid와 MUX가 필요하다. Sharing과 duplication의 전체 비용은 [Resource Sharing vs Duplication](resource_sharing_vs_duplication.md)에서 다룬다.

## 8. Backpressure와 Buffering

Ready/valid event, elastic storage, skid capacity와 FIFO occupancy의 canonical 설명은 [Buffering and Backpressure](buffering_and_backpressure.md)를 참고한다.

### No-backpressure source

Source가 매 cycle transaction을 보낼 수 있지만 block의 II가 4라면 다음 중 하나가 필요하다.

- Source가 `in_ready`를 지키도록 protocol 변경
- Input FIFO로 burst를 흡수
- 여러 lane 또는 pipeline으로 service capacity 증가
- Drop/retry semantics를 명시

FIFO는 평균 service rate보다 높은 지속 traffic을 해결하지 않는다. Burst를 지연시킬 뿐이며 장기 offered load가 service capacity를 넘으면 결국 가득 찬다.

### Output stall

`out_ready`가 있는 경우 producer는 handshake가 성립할 때까지 `out_valid`와 payload를 안정적으로 유지해야 할 수 있다. One-cycle pulse인 위 예제를 그대로 연결하면 result loss가 생긴다. Output holding register 또는 FIFO와 명확한 ready/valid protocol이 필요하다.

### Queue latency

Input FIFO가 있으면 service latency 외에 queue waiting time이 추가된다. System requirement가 end-to-end deadline이면 두 값을 함께 검증한다.

## 9. Latency 또는 II를 바꾸면 안 되는 경우

- 외부 protocol이 fixed response cycle을 요구하는데 interface version을 바꿀 권한이 없는 경우
- Feedback/control loop의 response deadline이 algorithm stability 또는 safety와 연결된 경우
- Output ordering과 tag가 없는 상태에서 variable-latency lane을 추가하는 경우
- CDC pulse rate를 throughput처럼 높이면서 crossing protocol의 event-rate 조건을 재검토하지 않은 경우
- Memory macro의 port/latency behavior를 확인하지 않고 II=1로 가정하는 경우
- Stall이 허용되지 않는 producer 앞에 busy-based unit을 연결하는 경우

Architecture가 이미 delayed capture를 요구하는 경우에만 timing constraint로 MCP를 표현할 수 있다. MCP는 II를 개선하거나 computation을 schedule하지 않는다. 자세한 내용은 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)를 참고한다.

## 10. Synthesis, STA와 Physical View

### Synthesis

Fixed loop를 RTL에 썼다는 이유로 multi-cycle schedule이 생기지 않는다. Combinational loop unrolling은 여러 operator 또는 긴 logic cone을 만들 수 있다. Iteration state, counter와 register update를 명시해야 cycle별 resource reuse가 표현된다.

### STA

II가 4라고 해서 내부 feedback adder path에 자동으로 4-cycle setup requirement가 생기는 것은 아니다. 위 accumulator는 각 active edge마다 `accum_q`를 갱신하므로 일반적으로 adder feedback path는 한 cycle 안에 완료되어야 한다. Functional capture schedule과 timing exception을 구분한다.

### Physical implementation

Pipeline 또는 lane 복제는 local path를 줄일 수 있지만 register/clock load, routing과 congestion을 늘릴 수 있다. Central scheduler와 wide ready fanout가 새 critical path가 될 수도 있다. Pre-layout 예상은 후보 선택용 가설이며 post-route feedback으로 확인한다.

## 11. PPA Trade-off를 측정하는 방법

후보 비교는 같은 조건에서 수행한다.

- 동일 기능, input range와 protocol
- 동일 target clock/constraint와 analysis corner
- 동일 workload 또는 representative activity
- FIFO, arbiter, MUX, valid/control을 포함한 비교 boundary
- Latency/II 변경으로 system queue와 clock frequency가 받는 영향

`area가 20% 감소한다` 같은 수치는 특정 library와 flow evidence 없이는 일반화하지 않는다. 대신 어떤 구조가 줄고 어떤 구조가 추가되는지 설명하고 report로 확인한다.

## 12. Common Mistakes

### Latency만 적는다

Busy unit의 accept rate를 매 cycle로 오해해 upstream transaction을 잃는다.

### II를 output 간격으로만 측정한다

Bubble, backpressure 또는 multiple lanes가 있으면 accept 간격과 completion 간격이 다를 수 있다.

### FIFO를 throughput 개선으로 본다

FIFO는 burst와 phase 차이를 흡수하지만 service resource의 지속 처리율을 높이지 않는다.

### Clock frequency를 무시한다

Transactions/cycle가 좋아져도 frequency가 크게 낮아지면 transactions/second 목표를 놓칠 수 있다.

### Busy clear와 새 accept를 같은 cycle에 우연히 처리한다

Nonblocking assignment와 branch priority를 이해하지 못하면 operand state가 덮어써지거나 bubble이 생긴다.

### Average latency만 검증한다

Worst-case response, fairness와 queue bound가 빠져 timeout 또는 starvation이 남는다.

## 13. Verification Strategy

### Schedule assertion

위 iterative example처럼 stall 없는 fixed schedule이라면 다음 contract를 검사할 수 있다.

```systemverilog
logic accept;
assign accept = in_valid && in_ready;

ap_fixed_latency:
    assert property (@(posedge clk) disable iff (!rst_n)
        accept |-> ##4 out_valid
    );

ap_no_accept_while_busy:
    assert property (@(posedge clk) disable iff (!rst_n)
        busy_q |-> !in_ready
    );

ap_no_ready_or_accept_during_reset:
    assert property (@(posedge clk)
        !rst_n |-> (!in_ready && !accept)
    );
```

설명용 property이며 실제 SVA sampling, reset style와 hierarchy visibility는 프로젝트 방법론에 맞춘다.

### Transaction association

- Accepted operand tuple을 scoreboard queue에 저장한다.
- Output마다 oldest expected transaction과 result를 비교한다.
- Back-to-back, minimum legal gap와 illegal early request를 구분한다.
- Reset/cancel이 expected queue를 어떤 규칙으로 비우는지 맞춘다.

### Performance verification

- Long continuous-valid traffic에서 accept 간격을 측정한다.
- Random backpressure에서 queue occupancy와 no-loss를 확인한다.
- Variable latency라면 min/max bound와 fairness assumption을 property로 만든다.
- Multiple lanes에서는 no-duplicate, no-drop, ordering/tag correctness를 확인한다.

## 14. Design Review Checklist

### Contract

- [ ] Accept, result-available와 consumed event가 구분됐는가?
- [ ] Latency와 II가 edge 기준으로 명시됐는가?
- [ ] Throughput 목표가 transactions/cycle과 transactions/second 중 필요한 단위로 정의됐는가?
- [ ] Variable latency의 min/max, ordering과 progress assumption이 있는가?

### Structure

- [ ] II를 제한하는 resource occupancy, feedback와 port 수를 찾았는가?
- [ ] Arbitration, merge와 ready path가 새로운 bottleneck이 아닌가?
- [ ] Buffer depth가 burst를 감당하며 지속 overload를 숨기지 않는가?
- [ ] Data, valid, tag와 error가 stall/flush 중 정렬되는가?
- [ ] Completion과 새 accept가 겹칠 때 state priority가 명시됐는가?

### Evidence

- [ ] Back-to-back와 maximum-rate traffic을 검증했는가?
- [ ] Latency/II assertion과 transaction scoreboard가 있는가?
- [ ] Synthesis가 예상 resource count와 register boundary를 만들었는가?
- [ ] Achieved frequency를 포함해 실제 throughput을 다시 계산했는가?
- [ ] Post-layout fanout, routing와 congestion이 capacity 가설을 유지하는가?

## 관련 문서

- [Requirement to Microarchitecture](requirement_to_microarchitecture.md)
- [Resource Sharing vs Duplication](resource_sharing_vs_duplication.md)
- [Canonical RTL Design Terminology](../01_fundamentals/terminology.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Multi-Cycle Path](../03_timing/multi_cycle_path.md)
- [Pulse Crossing](../08_cdc/pulse_crossing.md)
