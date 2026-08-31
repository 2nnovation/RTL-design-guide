# Feedback Dependency

Feed-forward datapath에서는 한 transaction의 결과가 뒤 stage로만 이동한다. Feedback 또는 recurrence에서는 이전 state의 결과가 다음 update의 입력으로 돌아온다. 이 차이는 pipeline register를 어디에 넣을 수 있는지, 같은 context의 다음 transaction을 언제 시작할 수 있는지, achievable initiation interval(II)이 얼마인지 결정한다.

> Feedback loop의 register는 단순한 timing boundary가 아니라 algorithm state다. Loop 안에 latency를 추가하면 다음 update가 어느 state를 읽는지가 달라질 수 있다.

Latency와 II의 canonical definition은 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md#3-latency-throughput-initiation-interval)를 따른다. Pipeline stage 구현은 [Pipeline Design](../03_timing/pipeline.md), timing exception은 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)가 담당한다. 이 문서는 **loop-carried dependency가 허용하는 schedule과 architecture transformation**에 집중한다.

## 1. Feed-Forward와 Recurrence를 구분한다

### Feed-forward

```text
input ── f0 ──> stage register ── f1 ──> output
```

Transaction A의 중간값이 B의 계산 입력으로 되돌아가지 않는다. Data와 control alignment를 보존하면 register를 추가해 logic cone을 나눌 수 있다. 여러 transaction이 서로 다른 stage에 동시에 있을 수 있다.

### Recurrence

```text
                 ┌──────── previous state ────────┐
                 ▼                                │
input[n] ──> update function ──> state register ──┘
                          state[n+1]
```

Iteration `n+1`은 iteration `n`이 만든 state를 사용한다. Update function 중간에 register를 추가하면 다음 cycle의 iteration이 최신 state 대신 더 오래된 state를 읽을 수 있다.

대표적인 recurrence:

- Running accumulator와 checksum state
- Counter/FSM next-state logic
- Iterative divide, square-root 또는 shift/add datapath
- Credit, occupancy와 pointer update
- Control loop와 retry/replay state

모든 feedback이 같은 것은 아니다. Register enable의 hold MUX처럼 같은 state를 유지하는 path와 algorithm이 매 transaction 갱신하는 recurrence를 구분한다.

## 2. Dependency Distance와 Available Latency

**Dependency distance**는 producer iteration과 그 결과를 소비하는 logical iteration 사이의 간격을 나타내는 architecture 분석 개념이다.

- `state[n+1] = F(state[n], input[n])`: distance 1
- `state[n+2] = F(state[n], input[n])`: distance 2

Distance 1 recurrence에서 update 결과가 `L` cycle 뒤에만 사용 가능하다면, 같은 context의 다음 dependent iteration을 매 cycle 시작할 수 없다. 다른 resource bottleneck이 없다는 단순 schedule에서는 recurrence가 허용하는 II의 하한을 개념적으로 다음처럼 볼 수 있다.

```text
recurrence-limited II >= ceil(update latency / dependency distance)
```

이는 sign-off 공식이나 tool constraint 문법이 아니다. 어떤 state version이 어느 iteration에 필요하고 언제 available한지를 빠르게 확인하는 schedule rule이다. Resource occupancy, memory port, arbitration과 backpressure가 더 큰 II를 요구할 수도 있다.

### Distance 1, update latency 1

```text
edge             E0       E1       E2       E3
accepted input    A        B        C
state used       S0       S1       S2
state written    S1       S2       S3

Each iteration reads the immediately preceding result.
II=1 is structurally possible if F meets one-cycle timing.
```

### Distance 1, update latency 2를 그대로 넣은 경우

```text
edge             E0       E1       E2       E3       E4
start             A                 B                 C
result                     S1                S2

Same-context iteration must wait for the prior result.
II cannot remain 1 without a transformation.
```

### Distance 2 또는 두 independent context

```text
edge             E0       E1       E2       E3       E4
context           X        Y        X        Y        X
iteration        X0       Y0       X1       Y1       X2

Each context sees two cycles between dependent updates.
Aggregate issue may be one per cycle while per-context II is two.
```

Interleaving은 dependency를 제거하지 않는다. Independent context를 번갈아 사용해 각 context가 필요한 available latency를 확보한다.

## 3. Pipeline Register를 무작정 추가하면 기능이 바뀌는 이유

다음 recurrence를 생각하자.

```text
S[n+1] = S[n] + X[n]
```

정상적인 running sum은 각 accepted input 뒤 state가 다음처럼 변한다.

```text
initial S = 0
accept A  → S = A
accept B  → S = A + B
accept C  → S = A + B + C
```

Adder 중간에 register를 넣고 여전히 매 cycle input을 accept하면 B 계산이 A가 반영되기 전 state를 읽을 수 있다. 결과는 intended prefix sum이 아니라 서로 다른 stale state를 사용하는 sequence가 된다.

```text
Broken assumption

S ── partial add ── [new register] ── final add ──> S
▲                                                    │
└────────────────────────────────────────────────────┘

Loop latency increased, but issue schedule was not changed.
```

Nonblocking assignment가 자동으로 iteration을 serialize하거나 최신 중간값을 bypass하지 않는다. RTL은 명시한 register state와 edge 관계만 구현한다.

## 4. RTL Example: One-Cycle Running Accumulator

다음 block은 accepted unsigned 16-bit sample을 20-bit running state에 더한다.

- `accept = in_valid && in_ready`
- `in_ready = rst_n && !flush && !stall`
- Event priority: reset → flush → stall → accept/idle
- Reset, flush 또는 stall 중에는 ready가 low이므로 외부 transaction이 accept되지 않는다.
- Back-to-back accept가 허용되며 distance-1 feedback path는 한 cycle 안에 완료되어야 한다.
- `out_valid`은 accepted update가 있는 cycle을 표시하며, back-to-back accept에서는 연속 cycle 동안 high일 수 있다.

```systemverilog
module running_accumulator (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        flush,
    input  logic        stall,
    input  logic        in_valid,
    output logic        in_ready,
    input  logic [15:0] in_value,
    output logic        out_valid,
    output logic [19:0] out_accum
);
    logic [19:0] accum_q;
    logic [19:0] value_ext;
    logic [19:0] accum_next;
    logic        accept;

    assign in_ready   = rst_n && !flush && !stall;
    assign accept     = in_valid && in_ready;
    assign value_ext  = {4'b0000, in_value};
    assign accum_next = accum_q + value_ext;

    // Event priority: reset > flush > stall > accept/idle.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            accum_q  <= 20'd0;
            out_valid <= 1'b0;
        end else if (flush) begin
            accum_q  <= 20'd0;
            out_valid <= 1'b0;
        end else if (stall) begin
            out_valid <= 1'b0;
        end else begin
            out_valid <= accept;
            if (accept) begin
                accum_q  <= accum_next;
                out_accum <= accum_next;
            end
        end
    end
endmodule
```

16-bit operand를 20-bit로 명시적으로 zero-extend한다. Accumulator overflow behavior는 20-bit modulo arithmetic이다. Saturation이나 error reporting이 requirement라면 21-bit intermediate와 explicit policy가 필요하다.

`stall`에서는 `accum_q`가 assignment되지 않아 hold되고 `out_valid`은 0이 된다. `flush`는 stall보다 우선하며 history를 제거한다. `in_ready`도 reset, flush와 stall 중 low이므로 `in_valid`이 high여도 handshake가 성립하지 않고 input state가 갱신되지 않는다. Output payload는 invalid cycle에 reset하거나 clear하지 않으며 consumer가 `out_valid == 1`일 때만 사용한다는 contract다.

### Cycle audit

```text
initial accum = 0

edge             E0          E1          E2          E3          E4
in_valid          1           1           0           1           1
flush             0           0           0           0           1
stall             0           0           1           0           0
in_ready          1           1           0           1           0
accepted          A           B           -           C           -
accum after edge  A           A+B         A+B         A+B+C       0
out_valid         1           1           0           1           0
```

E1 update는 E0 뒤 `accum_q=A`를 읽는다. E4에는 `flush`와 `in_valid`이 동시에 high이지만 `in_ready=0`이므로 accept가 아니며, flush branch가 state를 0으로 만든다. 이 one-cycle recurrence path가 target period를 만족하지 못한다면 `accum_next`에 단순 pipeline register를 넣고 같은 schedule을 유지할 수 없다.

## 5. Iterative Datapath와 Control Feedback

Iteration이 여러 cycle 걸리는 unit은 datapath state와 control state를 함께 소유한다.

```text
operand/state register ──> iterative operator ──> updated state
          ▲                        │                    │
          │                   step counter              │
          └──── busy / done / valid control ────────────┘
```

필요한 contract:

- Busy 중 새 input accept 여부
- Step counter와 datapath state의 update 우선순위
- Early completion 또는 exception 시 done cycle
- Stall에서 counter와 datapath가 함께 hold되는지
- Flush/reset에서 partial result를 폐기하는지
- Completion과 새 accept를 같은 edge에 허용하는지

[Latency, Throughput and Initiation Interval](latency_throughput_ii.md)의 iterative sum 예제는 resource occupancy schedule을 보여준다. 이 문서의 추가 질문은 각 step이 이전 `accum_q`를 올바르게 소비하는지다.

## 6. Timing을 개선할 수 있는 Transformation

### 6.1 Retiming

Retiming은 combinational logic 양쪽의 register 위치를 기능적으로 동등하게 이동하는 변환이다. Feed-forward path에서는 stage balance에 도움이 될 수 있다. Closed recurrence에서는 loop 전체 register count와 state observation point가 중요하므로 임의 이동이 허용되지 않는다.

적용 조건:

- Reset/enable/flush semantics가 이동 뒤에도 동등함
- External latency와 state observation contract가 유지됨
- Tool 또는 manual transformation의 sequential equivalence evidence가 있음
- Macro, gated clock 또는 boundary constraint가 이동을 막지 않음

### 6.2 Look-ahead 또는 Unrolling

두 update를 algebraically 결합할 수 있다면 다음 state를 미리 계산할 수 있다.

```text
S[n+1] = S[n] + X[n]
S[n+2] = S[n] + X[n] + X[n+1]
```

Associative unsigned modulo addition에서는 두 input을 묶는 후보가 가능하지만 다음 비용이 생긴다.

- 더 넓거나 깊은 combinational logic
- 여러 input을 함께 공급하는 interface와 buffer
- Partial output를 매 input마다 보여야 할 때의 bypass logic
- Overflow/saturation/rounding 순서가 바뀌는 위험
- Error, exception과 flush granularity 변경

Saturating addition이나 floating-point rounding처럼 연산 순서가 결과에 영향을 주면 단순 재결합이 동등하지 않을 수 있다.

### 6.3 Independent-context Interleaving

두 개 이상의 independent state를 두고 번갈아 update하면 한 context의 result가 돌아오는 동안 다른 context를 처리할 수 있다.

```text
state[context_id] ── pipelined update ──> state[context_id]
        ▲                         │
        └──── aligned context ID ─┘
```

비용과 조건:

- Context별 state/register 증가
- Context ID와 valid alignment
- 같은 context가 너무 빨리 재발행되지 않도록 hazard check
- Flush/reset의 context 범위
- Final merge 또는 ordering logic

Aggregate II와 per-context II를 구분한다.

### 6.4 Algorithm Reformulation

모든 prefix state가 관찰될 필요 없이 block 끝의 reduction 결과만 필요하다면 running recurrence를 adder tree로 바꿀 수 있다. 반대로 매 input 뒤 누적값을 외부가 관찰해야 한다면 같은 transformation은 contract를 바꾼다.

Architecture 변경 전 질문:

- Intermediate state가 architecturally visible한가?
- Operation이 associative/commutative한가?
- Numeric rounding, saturation과 exception order가 보존되는가?
- Buffering과 batch latency가 허용되는가?

## 7. MCP는 Feedback Dependency를 해결하지 않는다

MCP는 hardware에 state, bypass 또는 scheduler를 추가하지 않는다. Default STA capture relationship이 이미 존재하는 functional multi-cycle schedule과 다를 때 constraint로 표현할 뿐이다.

Running accumulator가 매 cycle `accum_q`를 update한다면 다음 path는 일반적으로 one-cycle path다.

```text
accum_q/Q ── adder ──> accum_q/D
```

Block의 end-to-end output latency가 여러 cycle이라는 이유로 이 recurrence path에 MCP를 적용할 수 없다. `accum_q`가 다음 active edge에 실제로 capture하기 때문이다. Timing을 만족하지 못하면 update function 단순화, state encoding/width 검토, look-ahead/interleaving 또는 algorithm/clock requirement 변경이 필요하다.

실제로 state update가 enable에 의해 여러 cycle에 한 번만 일어나고 source가 그 기간 안정적이라면 별도 multi-cycle contract를 검토할 수 있지만, 이는 RTL/protocol과 destination capture schedule의 evidence가 먼저 있어야 한다. 자세한 기준은 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)를 따른다.

## 8. Synthesis, STA와 Physical View

### Synthesis

Accumulator RTL은 일반적으로 state FF, adder와 update/hold selection으로 mapping될 수 있다. Reset, flush와 stall priority가 control MUX depth에 영향을 줄 수 있다. Enable-capable cell 또는 다른 structure 선택은 library와 synthesis context에 따라 달라진다.

### STA

확인할 path:

- State Q → update logic → same state D recurrence path
- Stall/flush/select의 late control path
- Step counter → operand MUX → datapath state
- Context ID/hazard control path

Worst path가 arithmetic인지 control인지 report로 구분한다. II가 크다는 이유만으로 path requirement가 자동 완화되지 않는다.

### Physical implementation

State와 update logic이 멀리 배치되면 feedback wire가 loop timing을 지배할 수 있다. Interleaved context bank, shared operator와 central control은 fanout/congestion을 늘릴 수 있다. Duplication 또는 local state partition이 timing을 개선할 가능성이 있지만 area, coherency와 switching을 함께 측정한다.

## 9. Timing, Power, Area Trade-off

| 후보 | Timing/II | Power | Area | 주요 위험 |
|---|---|---|---|---|
| One-cycle recurrence | II=1 가능, full update가 한 period 안에 필요 | 매 accept마다 state/operator activity | state+operator | critical feedback path |
| Slower iterative schedule | 같은 context II 증가 | active cycle 감소 가능 | operator 공유 가능, control 증가 | throughput/deadline |
| Look-ahead/unroll | 여러 iteration을 병렬 처리 가능 | speculative/duplicate switching | logic/input storage 증가 | numeric/order equivalence |
| Context interleaving | aggregate issue 개선 가능 | 여러 state bank activity | context state/tag 증가 | same-context hazard |
| Reformulated reduction | recurrence 제거 가능 | tree/glitch와 batch activity | operators/buffer 증가 가능 | interface semantics 변경 |

정량 결과는 width, operator implementation, target frequency, activity와 placement에 의존한다. 같은 workload와 contract boundary에서 합성·STA·power evidence를 비교한다.

## 10. 적용하면 안 되는 경우

- 최신 state가 매 cycle 필요한데 pipeline register만 추가하는 경우
- Saturation/rounding/exception order가 있는데 associative transformation으로 가정하는 경우
- Context가 independent하지 않은데 interleaving하는 경우
- Flush가 global인지 per-context인지 정의하지 않고 state bank를 복제하는 경우
- Output latency만 보고 internal recurrence에 MCP를 거는 경우
- Back-to-back input을 받으면서 single-owner iterative state를 덮어쓰는 경우
- CDC 또는 stopped-clock state를 synchronous recurrence schedule로 단순화하는 경우

## 11. Common Mistakes

### Feedback wire를 일반 data path로 본다

Register 추가 뒤 다음 iteration이 어떤 state version을 읽는지 추적하지 않는다.

### Latency와 II를 같은 값으로 고정한다

Context interleaving과 pipeline occupancy를 보지 않고 end-to-end latency로 issue rate를 추정한다.

### Iterative loop가 자동 multi-cycle timing이라고 생각한다

각 step이 매 edge state를 update하면 step 내부 path는 여전히 one-cycle requirement일 수 있다.

### Control feedback를 무시한다

Datapath는 맞지만 busy, step, valid 또는 owner가 한 cycle 어긋나 transaction을 잃는다.

### Reset/flush에서 partial state만 지운다

Valid/control은 clear했지만 accumulator나 context owner가 남아 다음 transaction과 섞인다. 반대로 payload가 valid로 완전히 mask되는데 불필요한 reset을 추가할 수도 있다.

### Algebraic equivalence를 numeric equivalence로 가정한다

Finite width, signedness, saturation과 rounding 때문에 연산 재배치 결과가 달라질 수 있다.

## 12. Verification Strategy

### State reference model

Accepted transaction sequence로 architectural state를 갱신하는 reference model을 둔다. RTL cycle이 아니라 `accept`, `flush`, context ID와 numeric policy를 기준으로 비교한다.

### Essential scenarios

- Back-to-back accept와 single bubble
- Stall 직전·중·직후 valid
- Flush와 `in_valid`이 동시에 오면 `in_ready=0`, no-accept이며 state가 clear되는지
- Reset 중/직후 요청
- Minimum/maximum operand, wrap 또는 saturation boundary
- 같은 context의 minimum legal issue gap
- Interleaved contexts와 out-of-order physical completion

### Example invariants

```systemverilog
ap_stall_holds_state:
    assert property (@(posedge clk) disable iff (!rst_n)
        (stall && !flush) |=> $stable(accum_q)
    );

ap_flush_clears_state:
    assert property (@(posedge clk) disable iff (!rst_n)
        flush |=> (accum_q == 20'd0 && !out_valid)
    );

ap_flush_blocks_accept:
    assert property (@(posedge clk) disable iff (!rst_n)
        flush |-> (!in_ready && !accept)
    );
```

이 property는 설명용이다. Assertion sampling, reset release와 simultaneous event는 프로젝트 방법론에 맞게 조정한다.

Transformation 전후에는 cycle-by-cycle equivalence가 아니라 allowed latency/context mapping을 포함한 sequential equivalence 또는 transaction/state-level comparison이 필요할 수 있다.

## 13. Design Review Checklist

### Dependency와 schedule

- [ ] Feed-forward path와 loop-carried dependency를 구분했는가?
- [ ] Producer/consumer iteration과 dependency distance가 명확한가?
- [ ] Update result available cycle과 same-context minimum issue gap이 일치하는가?
- [ ] Aggregate II와 per-context II를 구분했는가?
- [ ] Resource occupancy와 recurrence 중 실제 II bottleneck을 찾았는가?

### RTL과 state ownership

- [ ] Feedback state의 단일 owner와 update priority가 있는가?
- [ ] Datapath state, step/busy, valid와 context ID가 함께 advance/hold되는가?
- [ ] Width, signedness, overflow와 update order가 requirement와 일치하는가?
- [ ] Reset, flush와 stall에서 partial state가 안전한가?
- [ ] Reset, flush와 stall 중 `in_ready`가 낮아 external accept와 RTL update가 일치하는가?
- [ ] Back-to-back accept가 최신 state를 읽는가?

### Transformation와 evidence

- [ ] Retiming이 reset/enable과 external latency를 보존하는가?
- [ ] Look-ahead/unrolling의 algebraic·numeric equivalence가 증명됐는가?
- [ ] Interleaved contexts가 실제로 independent한가?
- [ ] MCP가 실제 destination capture schedule 없이 사용되지 않았는가?
- [ ] Synthesis/STA에서 recurrence와 late-control path를 확인했는가?
- [ ] Physical locality, fanout, area와 switching 결과를 비교했는가?

## 관련 문서

- [Latency, Throughput and Initiation Interval](latency_throughput_ii.md)
- [Architectural Timing Budget](architectural_timing_budget.md)
- [Parallelism and Pre-computation](parallelism_and_precomputation.md)
- [Pipeline Design](../03_timing/pipeline.md)
- [Multi-Cycle Path](../03_timing/multi_cycle_path.md)
- [Register Enable](../04_low_power/register_enable.md)
