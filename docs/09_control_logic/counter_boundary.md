# Counter Boundary Design

Counter bug는 대개 `+ 1` 연산 자체가 아니라 **범위, terminal cycle, simultaneous command와 overflow/underflow 정책**에서 생긴다. Counter를 작성하기 전에 저장 범위와 각 boundary request의 응답을 interface contract로 고정해야 한다.

최소 bit width와 arithmetic sizing은 [Bit Width Minimization](../05_area/bit_width_minimization.md) 및 [Width and Signedness](../01_fundamentals/width_and_signedness.md), 사용하지 않는 count window의 switching 제거는 [Counter Optimization](../04_low_power/counter_optimization.md)가 정본이다. 이 문서는 functional boundary semantics에 집중한다.

## 1. Range Contract에서 시작한다

Unsigned bounded counter의 요구사항을 다음처럼 쓴다.

```text
legal stored range = 0 .. MAX_COUNT, inclusive
WIDTH >= 1
MAX_COUNT must be representable in WIDTH bits
```

`MAX_COUNT=15`이면 4 bits로 충분하지만, `MAX_COUNT=16`이면 5 bits가 필요하다. Parameter가 port width에 쓰이면 `WIDTH=0`은 module 내부 assertion보다 먼저 잘못된 range를 만들 수 있으므로 build/configuration flow가 지원 범위를 사전 검증해야 한다.

Parameterized code에서는 unsized literal, signed conversion과 intermediate width가 contract를 바꾸지 않도록 한다. 아래 예제는 계산 가능한 parameter check를 위해 `1 <= WIDTH <= 63`을 지원 범위로 정한다. 더 넓은 counter가 필요하면 검증식과 constant type도 함께 확장한다.

## 2. Current Terminal과 Enter-Terminal Event

두 signal은 같은 것이 아니다.

```systemverilog
assign at_max = (count == MAX_VALUE);
assign at_zero = (count == '0);
```

- `at_max`: **현재 state**가 terminal이라는 level
- `enter_max`: 이번 accepted transition의 결과로 non-max에서 max로 **들어간 사건**

`at_max`는 max에 머무는 모든 cycle에 high다. 이를 event counter나 interrupt set에 직접 연결하면 중복 처리될 수 있다. 반면 `enter_max`는 max로 실제 이동한 edge 뒤 한 cycle pulse가 된다. Load로 max에 들어가는 것도 포함할지, max를 max로 다시 load하는 것을 event로 볼지는 명세해야 한다. 이 문서의 예제는 실제 state transition만 `enter_*`로 센다.

## 3. Boundary Policy 선택

| Policy | Max에서 up / zero에서 down | 장점 | 비용과 위험 |
|---|---|---|---|
| Wrap/modulo | 반대 boundary로 이동 | 단순 sequence에 적합 | wrap이 데이터 손실로 보일 수 있음 |
| Saturate | boundary에서 hold | range invariant 단순 | 요청이 처리됐는지 불명확할 수 있음 |
| Block + error | hold하고 error response | protocol 위반 관찰 가능 | error path/status 필요 |
| Extend width | 더 큰 범위를 저장 | overflow 지연/제거 | FF, adder, compare와 interface width 증가 |

Policy는 counter 종류마다 다를 수 있다. Ring index는 wrap이 자연스럽지만 occupancy나 credit는 overflow를 숨기면 안 된다. Software-visible statistic은 saturate와 sticky overflow가 적절할 수 있다. Safety protocol은 fail-stop이나 escalation을 요구할 수 있다.

## 4. Up/Down과 Load의 Event Contract

다음 generic 예제는 block+error policy를 사용한다.

> asynchronous reset → synchronous clear → accepted load → exactly-one up/down request → hold

세부 의미는 다음과 같다.

- `load_ready`는 payload 값과 무관하다. Valid/ready deadlock을 피하기 위해 invalid payload도 **accepted command**가 되고 error response를 만든다.
- In-range load는 count를 갱신한다. Invalid load는 count를 유지하고 `boundary_error`를 pulse로 낸다.
- `up_req ^ down_req`이면 step command를 accept한다. Boundary에서 accepted step은 count를 바꾸지 않고 `boundary_error`로 응답한다.
- `up_req && down_req`이면 둘 다 accept하지 않고 `conflict_error`를 pulse로 낸다.
- Load command가 accepted된 cycle에는 up/down conflict도 load보다 낮은 priority라서 평가하지 않는다.

```systemverilog
module bounded_up_down_counter #(
  parameter int unsigned     WIDTH     = 4,
  parameter longint unsigned MAX_COUNT = 15
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic             clear,

  input  logic             load_valid,
  output logic             load_ready,
  input  logic [WIDTH-1:0] load_value,
  output logic             load_accept,

  input  logic             up_req,
  input  logic             down_req,
  output logic             step_accept,

  output logic [WIDTH-1:0] count,
  output logic             at_zero,
  output logic             at_max,
  output logic             enter_zero,
  output logic             enter_max,
  output logic             conflict_error,
  output logic             boundary_error
);
  localparam logic [WIDTH-1:0] MAX_VALUE = WIDTH'(MAX_COUNT);
  localparam logic [WIDTH-1:0] ONE = 'd1;

  logic [WIDTH-1:0] count_d;
  logic enter_zero_d, enter_max_d;
  logic conflict_error_d, boundary_error_d;
  logic load_in_range;
  logic transition_commit;

  generate
    if ((WIDTH < 1) || (WIDTH > 63)) begin : g_bad_width
      initial $fatal(1, "WIDTH must be in the range 1..63");
    end else if (MAX_COUNT > ((64'd1 << WIDTH) - 1)) begin : g_bad_max
      initial $fatal(1, "MAX_COUNT is not representable in WIDTH bits");
    end
  endgenerate

  assign at_zero = (count == '0);
  assign at_max  = (count == MAX_VALUE);
  assign load_in_range = (load_value <= MAX_VALUE);

  assign load_ready  = rst_n && !clear;
  assign load_accept = load_valid && load_ready;

  // Acceptance means the command was handled. At a boundary it returns error
  // without committing a new count value.
  assign step_accept = rst_n && !clear && !load_accept &&
                       (up_req ^ down_req);

  always_comb begin
    count_d          = count;
    enter_zero_d     = 1'b0;
    enter_max_d      = 1'b0;
    conflict_error_d = 1'b0;
    boundary_error_d = 1'b0;
    transition_commit = 1'b0;

    if (rst_n && !clear) begin
      if (load_accept) begin
        if (load_in_range) begin
          count_d = load_value;
          transition_commit = (load_value != count);
        end else begin
          boundary_error_d = 1'b1;
        end
      end else if (up_req && down_req) begin
        conflict_error_d = 1'b1;
      end else if (up_req) begin
        if (at_max) begin
          boundary_error_d = 1'b1;
        end else begin
          count_d = count + ONE;
          transition_commit = 1'b1;
        end
      end else if (down_req) begin
        if (at_zero) begin
          boundary_error_d = 1'b1;
        end else begin
          count_d = count - ONE;
          transition_commit = 1'b1;
        end
      end
    end

    if (transition_commit) begin
      enter_zero_d = (count_d == '0) && (count != '0);
      enter_max_d  = (count_d == MAX_VALUE) && (count != MAX_VALUE);
    end
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      count          <= '0;
      enter_zero     <= 1'b0;
      enter_max      <= 1'b0;
      conflict_error <= 1'b0;
      boundary_error <= 1'b0;
    end else if (clear) begin
      count          <= '0;
      enter_zero     <= 1'b0;
      enter_max      <= 1'b0;
      conflict_error <= 1'b0;
      boundary_error <= 1'b0;
    end else begin
      count          <= count_d;
      enter_zero     <= enter_zero_d;
      enter_max      <= enter_max_d;
      conflict_error <= conflict_error_d;
      boundary_error <= boundary_error_d;
    end
  end
endmodule
```

`initial $fatal`의 synthesis/elaboration 지원은 tool flow에 따라 다르다. Module generator, lint 또는 build system에서도 같은 legality를 검사한다. Parameter check가 있다는 이유로 invalid-width port 선언이 안전해지는 것은 아니다.

## 5. Invalid Load와 Ready/Valid

`load_ready = (load_value <= MAX_VALUE)`로 만들면 source가 invalid value를 acceptance까지 유지하는 정상 ready/valid 규칙 아래에서 양쪽이 영원히 멈출 수 있다. 예제는 command를 accept하고 error로 응답하므로 progress가 명확하다.

다른 가능한 계약은 다음과 같다.

- Invalid payload가 interface에서 불가능하다는 environment assumption과 assertion
- `load_ready`와 별도의 `load_error_valid/load_error_ready` response channel
- Invalid load를 clamp하고 correction/error를 함께 보고
- Protocol 전체를 fail-stop하고 reset 또는 privileged recovery를 요구

어느 경우든 “ready가 낮았으니 error도 아니다”와 “accepted됐으니 state가 반드시 바뀌었다”를 혼동하지 않는다. Acceptance와 commit을 별도 개념으로 정의할 수 있다.

## 6. Cycle Audit

`WIDTH=3`, `MAX_COUNT=5`인 예를 보자.

| Edge | Pre-count/commands | Accepted/response | Post-count | Event output |
|---|---|---|---:|---|
| E0 | reset | 없음 | 0 | 모두 0 |
| E1 | 0, load 4 valid | load accept + commit | 4 | 없음 |
| E2 | 4, up | step accept + commit | 5 | `enter_max=1` |
| E3 | 5, up | step accept, blocked | 5 | `boundary_error=1` |
| E4 | 5, down | step accept + commit | 4 | 없음 |
| E5 | 4, up+down | reject conflict | 4 | `conflict_error=1` |
| E6 | 4, invalid load 6 + down | load accept, no commit | 4 | `boundary_error=1` |
| E7 | 4, clear + valid load + up | 어떤 command도 accept 안 함 | 0 | error/event clear |
| E8 | 0, down | step accept, blocked | 0 | `boundary_error=1` |
| E9 | 0, load 0 | load accept, no transition | 0 | `enter_zero=0` |

E2의 `at_max`는 edge 뒤부터 high이고, `enter_max`는 E2 update를 나타내는 한 cycle registered pulse다. E3에서는 `at_max=1`이 유지되지만 `enter_max`는 다시 발생하지 않는다.

추가 parameter corner를 별도 test한다.

- `WIDTH=1, MAX_COUNT=0`: 유일한 legal value는 0이며 모든 step이 boundary error
- `WIDTH=1, MAX_COUNT=1`: 0과 1 사이의 legal up/down
- `MAX_COUNT=2^WIDTH-1`: natural binary limit와 explicit boundary 일치
- Non-power-of-two maximum: unused encodings이 절대 저장되지 않는지 확인
- Minimum/maximum legal load와 첫 invalid load

## 7. Up/Down 변형

### Wrap

Max에서 up이면 zero, zero에서 down이면 max로 이동한다. 이때 `enter_zero`/`enter_max`는 실제 wrap transition event로 발생할 수 있다. Natural bit truncation에 의존하지 말고 non-power-of-two maximum에서도 명시적으로 구현한다.

### Saturate

Boundary에서 hold한다. Request를 accepted로 셀지, ignored로 셀지, saturation status를 sticky로 남길지 정한다. Silent hold는 upstream accounting과 다를 수 있다.

### Larger step

Step이 1보다 크면 `count == MAX_VALUE` 검사만으로 부족하다. Extended-width intermediate로 `count + step`을 계산하고 range compare 후 commit한다. Subtraction도 borrow/underflow를 signedness에 기대지 말고 명시한다.

### Reversible simultaneous up/down

Up과 down을 merge해 net zero로 처리하는 계약도 가능하다. 그러나 두 source가 각각 acceptance를 기대한다면 둘 다 accepted되었다는 indication이 필요하다. 예제는 ambiguous conflict를 reject/error로 처리한다.

## 8. Synthesis, STA와 PPA 관점

Bounded counter는 보통 FF, increment/decrement arithmetic, terminal comparator와 update MUX로 mapping된다. Up/down, load와 error 기능을 모두 넣으면 simple incrementer보다 decode가 커진다.

Critical path는 target library와 mapping에 따라 다음 중 하나일 수 있다.

- count FF → terminal compare → enable/MUX → count FF
- count FF → add/subtract carry chain → count FF
- command priority/invalid-load compare → update select
- terminal/event decode의 high-fanout route

Width를 줄이면 FF, clock load, comparator와 carry chain이 줄 가능성이 있지만, exact PPA는 library, constraints, synthesis와 placement에 의존한다. Terminal flag를 register하거나 down-counter로 변환하면 path가 달라질 수 있으나 externally visible count, latency와 boundary cycle도 보존해야 한다.

## 9. 적용하면 안 되는 패턴

- Non-power-of-two maximum에서 bit overflow만으로 wrap한다.
- Signed/unsigned implicit conversion으로 underflow 검사를 대신한다.
- `at_max` level을 one-shot terminal event처럼 사용한다.
- Invalid load를 truncate한 뒤 정상 acceptance로 보고한다.
- Simultaneous up/down을 RTL assignment 순서에 맡긴다.
- Parameter check 없이 `$clog2` 결과를 그대로 port width로 쓴다.
- Boundary policy가 다른 counters를 하나의 공통 template로 강제한다.

## 10. Verification Strategy

### Assertions

Register update 결과는 accepted edge의 다음 sample에서 `|=>`로 검사한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_count_in_range:
  assert property (count <= MAX_VALUE);

ap_clear_priority:
  assert property (clear |=>
                   count == '0 && !enter_zero && !enter_max &&
                   !conflict_error && !boundary_error);

ap_valid_load_commits:
  assert property (load_accept && load_in_range |=>
                   count == $past(load_value));

ap_invalid_load_holds_and_errors:
  assert property (load_accept && !load_in_range |=>
                   $stable(count) && boundary_error);

ap_legal_up_commits:
  assert property (step_accept && up_req && !at_max |=>
                   count == ($past(count) + ONE));

ap_up_at_max_holds_and_errors:
  assert property (step_accept && up_req && at_max |=>
                   $stable(count) && boundary_error);

ap_conflict_is_rejected:
  assert property (!clear && !load_accept && up_req && down_req |=>
                   $stable(count) && conflict_error);

ap_enter_max_is_terminal:
  assert property (enter_max |-> at_max);
```

Down direction과 `enter_zero`에 대칭 property를 추가한다. `$stable(count)`는 다음 sample의 값이 이전 sample과 같은지를 확인한다. Async reset이 sample 사이에 asserted되면 `disable iff` 정책과 reset-specific property를 별도로 검토한다.

### Formal과 directed test

- 모든 legal state에서 range invariant를 prove한다.
- Arbitrary command overlap으로 priority와 no-silent-drop/error contract를 검사한다.
- `0`, `1`, `MAX-1`, `MAX`와 invalid load를 직접 자극한다.
- Cover로 zero→max가 아니라 모든 legal intermediate transition과 both terminal entry를 관찰한다.
- Parameter sweep으로 `MAX=0`, `1`, non-power-of-two와 full-scale maximum을 elaboration/test한다.

## 11. Design Review Checklist

- [ ] Legal stored range와 inclusive/exclusive maximum이 명시됐는가?
- [ ] `WIDTH >= 1`과 `MAX_COUNT` representability를 build에서 검증하는가?
- [ ] Current terminal level과 enter-terminal event를 구분했는가?
- [ ] Wrap, saturate, block+error 또는 extend-width policy를 선택했는가?
- [ ] Clear, load, up와 down의 simultaneous priority가 정의됐는가?
- [ ] Invalid load가 accept, reject, clamp 또는 fail-stop 중 무엇인지 명확한가?
- [ ] Up+down conflict의 acceptance/error 의미가 있는가?
- [ ] Max-up과 zero-down의 count, accept와 error 결과가 일관적인가?
- [ ] `MAX=0`, `MAX=1`과 non-power-of-two를 test했는가?
- [ ] Boundary cycle을 pre-state/event/post-state 표로 감사했는가?
- [ ] Assertions가 range, hold, transition과 NBA sampling을 확인하는가?
- [ ] Width/PPA 변경 전후에 같은 functional boundary contract를 유지하는가?

## 관련 문서

- [Bit Width Minimization](../05_area/bit_width_minimization.md)
- [Width and Signedness](../01_fundamentals/width_and_signedness.md)
- [Counter Optimization](../04_low_power/counter_optimization.md)
- [FSM and Counter Encoding](../05_area/fsm_counter_encoding.md)
- [Priority and Simultaneous Events](priority_and_simultaneous_events.md)
- [Pulse, Level, and Event](pulse_level_event.md)
- [Overflow, Saturation, and Rounding](../10_datapath/overflow_saturation_rounding.md)
