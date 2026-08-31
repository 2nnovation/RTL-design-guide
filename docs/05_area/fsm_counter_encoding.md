# FSM and Counter Encoding

FSM이나 counter의 “bit 수”만 줄인다고 전체 area가 최소가 되지는 않는다. 실제 비용에는 state FF, next-state/decode logic, output decode, reset/illegal-state recovery, fanout, buffering과 routing이 함께 들어간다. Encoding은 기능 계약과 target implementation을 함께 보고 선택한다.

> Binary, one-hot, Gray-like encoding 중 항상 우수한 방식은 없다. 합성 옵션, library, FPGA/ASIC target, transition graph, timing constraint와 물리 배치가 결과를 바꾼다.

State의 역할과 owner를 정하는 방법은 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md), 폭 산정은 [Bit Width Minimization](bit_width_minimization.md), CDC용 Gray counter의 별도 계약은 [Multi-bit CDC](../08_cdc/multi_bit_cdc.md)가 담당한다.

## 1. 무엇을 최소화하는가

FSM의 구현 비용을 다음처럼 나누어 본다.

```text
total cost
  = state storage
  + next-state logic
  + output decode/MUX
  + reset and illegal-state handling
  + fanout buffers and routing
  + timing/hold/congestion fixes
```

예를 들어 one-hot은 state FF 수가 많지만 각 transition이 작은 AND/OR cone으로 구현될 수 있다. Binary는 FF 수가 적지만 여러 state bit를 decode하는 logic과 reconvergent path가 생길 수 있다. 작은 FSM에서 차이는 미미할 수 있고, 큰 fanout을 가진 control FSM에서는 physical effect가 지배적일 수 있다.

## 2. Encoding 선택지

| Encoding | Storage | Decode/transition 경향 | 주의점 |
|---|---:|---|---|
| Binary/compact | `ceil(log2(N))` bits | decode가 깊어질 수 있음 | unused code, illegal recovery |
| One-hot | 대체로 `N` bits | state bit 자체를 enable로 사용 가능 | FF/reset/clock load 증가 |
| Gray-like | transition별 bit toggle 감소 가능 | arbitrary graph에는 단순하지 않음 | CDC safety를 자동 보장하지 않음 |
| Custom sparse | graph와 output에 맞춤 | critical arc를 단순화 가능 | 유지보수와 tool portability |
| Ring/Johnson/LFSR | sequence 생성에 유리할 수 있음 | terminal/illegal behavior가 특수함 | 일반 numeric count와 다름 |

Encoding attribute를 지정하지 않으면 합성 도구가 target/constraint에 따라 recode할 수 있다. 반대로 attribute로 고정하면 tool의 탐색 공간을 줄인다. 어느 쪽이든 RTL source의 enum 모양만 보고 mapped encoding을 단정하지 말고 synthesis report와 netlist를 확인한다.

## 3. FSM 구조와 Event Priority

다음 예제는 review가 쉬운 명시적 one-hot encoding이다. Contract는 다음과 같다.

- `start`, `cancel`, `finish`는 해당 state에서 샘플되는 synchronous command다.
- Event priority는 reset이 가장 높다.
- `RUN`에서 `cancel`과 `finish`가 동시에 오면 `cancel`이 이긴다.
- `DONE`은 한 cycle 유지한 뒤 `IDLE`로 돌아간다.
- Illegal encoding은 RTL에서 `IDLE` recovery를 요청한다.

```systemverilog
module onehot_job_fsm (
    input  logic clk,
    input  logic rst_n,
    input  logic start,
    input  logic cancel,
    input  logic finish,
    output logic busy,
    output logic done
);
    typedef enum logic [2:0] {
        ST_IDLE = 3'b001,
        ST_RUN  = 3'b010,
        ST_DONE = 3'b100
    } state_t;

    state_t state_q;
    state_t state_d;

    always_comb begin
        state_d = state_q;

        unique case (state_q)
            ST_IDLE: begin
                if (start) begin
                    state_d = ST_RUN;
                end
            end

            ST_RUN: begin
                if (cancel) begin
                    state_d = ST_IDLE;
                end else if (finish) begin
                    state_d = ST_DONE;
                end
            end

            ST_DONE: begin
                state_d = ST_IDLE;
            end

            default: begin
                state_d = ST_IDLE;
            end
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state_q <= ST_IDLE;
        end else begin
            state_q <= state_d;
        end
    end

    assign busy = (state_q == ST_RUN);
    assign done = (state_q == ST_DONE);
endmodule
```

`unique case`는 simulation/lint 의도를 표현하지만, 그 자체가 silicon의 fault recovery 회로를 보장하지 않는다. Safe-FSM insertion, parity, duplication 또는 error output이 필요하면 해당 safety contract와 tool flow를 별도로 정의한다.

### Cycle audit

```text
edge/state before     E0/IDLE      E1/RUN       E2/IDLE      E3/RUN
start/cancel/finish   1/0/0        0/1/1        1/0/0        0/0/1
state after           RUN          IDLE          RUN          DONE
winning command       start        cancel        start        finish
```

E1은 simultaneous-command priority를 고정한다. 이 priority를 바꾸면 기능 변경이므로 encoding optimization과 섞어 처리하지 않는다.

## 4. Binary와 One-hot을 비교할 때

Source-level FF count만 비교하지 않는다.

1. 같은 state/output/priority contract로 두 후보를 만든다.
2. 같은 constraint와 synthesis effort를 사용한다.
3. State FF, combinational cells, MUX, buffer와 reset load를 비교한다.
4. State-to-state와 state-to-output timing path를 비교한다.
5. Placement 뒤 congestion, high-fanout control과 hold fixes를 비교한다.
6. Formal equivalence 또는 transition/output assertion으로 기능을 확인한다.

One-hot output가 state bit 하나에서 바로 나와 빠를 수 있지만 그 bit가 수많은 sinks를 구동하면 buffer/replication이 생긴다. Binary decode는 gate가 늘어도 consumer 근처에서 복제되어 physical locality가 더 좋을 수 있다.

## 5. Illegal와 Unreachable State

Compact encoding은 사용하지 않는 code point를 가진다. One-hot도 all-zero나 multi-hot state가 불법일 수 있다. 결정해야 할 사항:

- Illegal state가 architecturally observable한가?
- Recovery target과 latency는 무엇인가?
- Recovery 중 output은 safe한가?
- Fault injection/safety verification 대상인가?
- Synthesis가 unreachable assumption으로 recovery logic을 제거해도 되는가?

불법 상태를 default로 복구하는 RTL과 “불법 상태는 절대 발생하지 않는다”는 optimization assumption은 서로 다른 목표다. Tool option과 netlist에서 의도가 보존됐는지 확인한다.

## 6. Counter는 숫자인가, Sequence인가

Counter 최적화 전에 의미를 구분한다.

- Numeric count: software-visible 값, occupancy, timeout age처럼 산술 의미가 있음
- Modulo counter: 명시된 modulus에서 wrap
- Sequence generator: 순서만 중요하며 binary 숫자값은 중요하지 않음
- Pointer/phase: wrap bit, full/empty 또는 CDC contract와 결합

Ring, Johnson, LFSR은 sequence generator에는 유리할 수 있지만 일반 binary numeric count를 대체하지 않는다. State 수, zero state lock-up, terminal decode와 initialization을 별도로 검증해야 한다.

## 7. Counter Width와 Terminal Decode

최대값이 `MAX_COUNT`인 inclusive counter의 최소 저장 폭은 대체로 다음과 같다.

```systemverilog
localparam int unsigned COUNT_W =
    (MAX_COUNT < 1) ? 1 : $clog2(MAX_COUNT + 1);

logic [COUNT_W-1:0] count_q;
```

그러나 폭만 줄이면 충분하지 않다.

- `MAX_COUNT+1`의 elaboration width/overflow
- Signed/unsigned comparison
- Non-power-of-two의 unused codes
- Increment와 terminal compare가 같은 critical path에 있는지
- Saturating, wrapping, clearing의 event priority
- Parameter 최소/최대값

Terminal compare를 미리 등록하면 compare path가 줄 수 있지만 state와 latency가 늘어난다. 반대로 down-counter의 zero detect가 더 단순할 수 있지만 reload/subtract path와 externally visible value를 바꿀 수 있다. 반드시 같은 functional contract로 비교한다.

## 8. Counter Event Priority 예시

다음 priority는 흔하지만 보편 규칙은 아니다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        count_q <= '0;
    end else if (clear) begin
        count_q <= '0;
    end else if (load) begin
        count_q <= load_value;
    end else if (enable) begin
        if (count_q == MAX_COUNT_VALUE) begin
            count_q <= '0;
        end else begin
            count_q <= count_q + 1'b1;
        end
    end
end
```

여기서 reset → clear → load → increment → hold가 기능 계약이다. `load`와 `enable` 동시 동작, terminal에서의 load, reset 직후 값을 cycle table로 고정한다. `MAX_COUNT_VALUE`는 `count_q`와 같은 unsigned width로 선언하고 parameter 범위를 elaboration에서 검사해야 한다.

## 9. Synthesis, STA와 Physical View

### Synthesis

- 실제 encoding과 recoding report
- State FF와 resettable cell 수
- Next-state/output decode의 depth와 cell count
- Shared decode가 유지됐는지 또는 복제됐는지
- Counter adder/comparator/carry-chain mapping

### STA

- Input → next-state → state FF
- State FF → output decode → consumer
- Counter Q → increment/terminal MUX → D
- High-fanout state bit와 enable path

### Physical implementation

State FF 수가 적어도 decode가 넓게 퍼지면 route/buffer area가 커질 수 있다. One-hot FF가 consumer cluster 근처에 배치되면 locality가 좋아질 수도 있다. 반대로 reset/clock load와 multi-bit state routing이 커질 수도 있다. [Physical Area and Congestion](physical_area_and_congestion.md)의 placed evidence를 함께 본다.

## 10. PPA Trade-off

| Choice | Timing | Power | Area | 주요 위험 |
|---|---|---|---|---|
| Compact FSM | decode depth 증가 가능 | fewer FF clocks | storage 감소 | illegal code/decode |
| One-hot FSM | transition/output 단순 가능 | more FF clocks | FF 증가, logic 감소 가능 | reset/fanout |
| Gray-like transition | bit toggle 감소 가능 | state toggle 감소 가능 | custom logic 증가 가능 | graph/CDC 오해 |
| Narrow counter | shorter adder 가능 | clocked bits 감소 | FF/logic 감소 | range/overflow |
| Registered terminal | critical compare 분리 | extra FF activity | state 증가 | latency/coherency |

## 11. 적용하면 안 되는 경우

- External register/debug/test interface가 raw state encoding을 관찰하는데 호환 계획 없이 recode하는 경우
- Timing-critical one-hot FSM을 mapped/post-place evidence 없이 compact encoding으로 강제하는 경우
- Safety requirement가 illegal-state detection/recovery를 요구하는데 unreachable assumption으로 logic을 제거하는 경우
- Numeric counter value가 architecturally visible한데 ring/LFSR sequence로 바꾸는 경우
- CDC pointer의 Gray/protocol bits를 일반 FSM/counter area optimization으로 변경하는 경우
- Latency, terminal cycle 또는 event priority가 달라지는 후보를 단순 encoding 변경으로 취급하는 경우

## 12. Common Mistakes

- State 수만 보고 binary가 항상 작다고 결론낸다.
- FPGA의 one-hot 경험을 ASIC에 그대로 일반화하거나 그 반대를 한다.
- CDC Gray counter와 arbitrary FSM Gray-like encoding을 같은 문제로 본다.
- Encoding attribute를 넣고 mapped result를 확인하지 않는다.
- `unique`/`default`가 자동으로 safe recovery를 보장한다고 생각한다.
- Counter width를 줄이면서 signedness, wrap와 terminal cycle을 바꾼다.
- Synthesis cell area만 보고 buffers, routing, hold fixes를 제외한다.

## 13. Verification Strategy

- 모든 legal transition과 prohibited transition assertion
- Simultaneous command priority
- Reset, illegal-state injection과 recovery output
- One-hot이면 `$onehot(state_q)`, reset 포함 정책에 따라 `$onehot0`
- Encoding 후보 간 sequential equivalence
- Counter boundary: zero, terminal-1, terminal, wrap/saturate
- Parameter minimum, non-power-of-two와 maximum configuration
- Synthesis recoding/netlist and post-place timing review

```systemverilog
ap_legal_onehot:
    assert property (@(posedge clk) disable iff (!rst_n)
        $onehot(state_q)
    );

ap_cancel_priority:
    assert property (@(posedge clk) disable iff (!rst_n)
        state_q == ST_RUN && cancel && finish |=> state_q == ST_IDLE
    );
```

## 14. Design Review Checklist

- [ ] FSM/counter의 externally visible contract와 event priority가 고정됐는가?
- [ ] Storage뿐 아니라 decode, MUX, fanout, reset과 physical fixes를 비교했는가?
- [ ] Tool recoding 허용/고정 정책과 실제 mapped encoding을 확인했는가?
- [ ] Illegal/unreachable state assumption과 recovery가 일치하는가?
- [ ] Counter가 numeric value인지 sequence인지 구분했는가?
- [ ] Width, signedness, terminal, wrap와 parameter edge를 검증했는가?
- [ ] 동일 constraint로 synthesis/STA/place 결과를 비교했는가?
- [ ] CDC pointer라면 CDC-specific Gray contract를 별도로 검토했는가?

## 관련 문서

- [Area Overview](overview.md)
- [Bit Width Minimization](bit_width_minimization.md)
- [Unused Logic and State Reduction](unused_logic_and_state_reduction.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [FSM Design](../09_control_logic/fsm_design.md)
- [Counter Boundary Design](../09_control_logic/counter_boundary.md)
- [Illegal State Recovery](../09_control_logic/illegal_state_recovery.md)
- [Multi-bit CDC](../08_cdc/multi_bit_cdc.md)
- [Physical Area and Congestion](physical_area_and_congestion.md)
