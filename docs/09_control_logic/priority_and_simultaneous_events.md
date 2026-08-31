# Priority and Simultaneous Events

여러 control condition이 같은 clock edge에 참이 될 수 있다면 그 조합은 corner case가 아니라 interface specification의 일부다. 설계자는 각 조합을 **priority, merge, reject 또는 queue** 중 하나로 처리하고, request와 실제 accepted event를 구분해야 한다.

`if`, `case`, MUX와 priority encoder의 합성 구조·timing은 [Priority and MUX](../01_fundamentals/priority_and_mux.md)가 정본이다. 이 문서는 동시 사건의 기능 계약과 cycle-level 검증에 집중한다.

## 1. 네 가지 결정

두 사건 A와 B가 같은 edge에 제시될 수 있다면 다음 중 하나를 명시한다.

| 결정 | 같은 edge의 의미 | 필요한 interface/상태 |
|---|---|---|
| Priority | 한 사건만 수행하고 다른 사건은 defer 또는 무시 | 승자 순서, 패자 재시도 규칙 |
| Merge | 두 사건의 효과를 하나의 atomic update로 결합 | 결합 결과와 old/new value semantics |
| Reject | 조합을 받지 않고 error 또는 backpressure | reject/error indication, retry 규칙 |
| Queue | 둘 다 보존해 다른 cycle에 수행 | storage depth, ordering, overflow policy |

“발생하지 않는다”는 다섯 번째 구현 방법이 아니다. 환경 contract라면 assertion/assumption으로 검증해야 한다. 발생 가능하지만 동작을 정의하지 않으면 simulation, synthesis와 integration에서 우연한 결과를 얻게 된다.

## 2. Request와 Accepted Event

Level input이 high라는 사실과 state update가 수행됐다는 사실을 분리한다.

```systemverilog
assign load_accept = load_valid && load_ready;
assign step_accept = step_req   && step_ready;
```

- `load_valid`: source가 load request와 payload를 제시한다.
- `load_ready`: destination이 이 cycle에 받을 수 있다.
- `load_accept`: 이 edge에 ownership이 이동한다.

Counter, transaction count, FSM transition과 side effect는 보통 `valid`가 아니라 `accept`에 연결한다. 그렇지 않으면 backpressure 동안 held-high request를 매 cycle 새 사건으로 중복 처리할 수 있다.

## 3. 흔한 동시 사건을 먼저 표로 쓴다

### Clear, load, count

| `clear` | `load_valid` | `count_req` | 가능한 계약 예 | 패자 처리 |
|---:|---:|---:|---|---|
| 0 | 0 | 0 | hold | 없음 |
| 0 | 0 | 1 | count accept | 없음 |
| 0 | 1 | 0 | load accept | 없음 |
| 0 | 1 | 1 | load > count | count backpressure/retry |
| 1 | X | X | clear | ready를 낮춰 어떤 request도 accept하지 않음 |

Load와 count를 merge해 `load_data + 1`을 저장하는 계약도 가능하지만, RTL 순서만 바꾸어 그런 의미를 만들면 안 된다.

### Reset, flush, request

Reset은 저장소를 정의된 초기 상태로 만들고, flush는 현재 transaction을 취소하는 synchronous protocol event일 수 있다. 흔한 계약은 `reset > flush > request acceptance`이지만 보편 법칙은 아니다. Flush에 대한 completion/error response가 필요하면 단순 폐기가 아니라 별도 phase가 필요할 수 있다.

### Set와 clear

Sticky status bit에서 `set && clear`의 의미는 특히 중요하다.

- **Set-dominant**: 새 error/event를 잃지 않는다.
- **Clear-dominant**: software clear가 현재 관찰된 status까지 포함한다.
- **Merge/count**: bit가 아니라 pending count가 필요하다.
- **Reject**: clear를 받지 않고 재시도시키거나 conflict를 알린다.

어느 선택도 이름만으로 정해지지 않는다. Clear가 어떤 snapshot을 acknowledge하는지까지 정의한다.

## 4. Generic Priority Contract

다음 예제의 functional priority는 명시적으로 다음과 같다.

> asynchronous reset → flush → accepted load → accepted step → hold

Flush 중에는 ready를 낮춘다. Load가 제시되면 step에 backpressure를 걸어 패자 request가 silent drop되지 않게 한다. Source는 acceptance까지 request를 유지해야 한다.

```systemverilog
module prioritized_event_state (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       flush,

  input  logic       load_valid,
  output logic       load_ready,
  input  logic [7:0] load_data,

  input  logic       step_req,
  output logic       step_ready,

  output logic [7:0] state_value
);
  logic [7:0] state_q;
  logic load_accept, step_accept;

  assign load_ready = rst_n && !flush;
  assign load_accept = load_valid && load_ready;

  assign step_ready = rst_n && !flush && !load_valid;
  assign step_accept = step_req && step_ready;

  assign state_value = state_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      state_q <= '0;
    else if (flush)
      state_q <= '0;
    else if (load_accept)
      state_q <= load_data;
    else if (step_accept)
      state_q <= state_q + 8'd1;
  end
endmodule
```

이 예제는 step 결과를 8-bit modulo arithmetic으로 정의한다. Saturate/error가 필요하면 [Counter Boundary Design](counter_boundary.md)의 별도 boundary contract를 사용한다.

`step_ready`가 `!load_valid`에 의존하므로 unaccepted load request도 step보다 우선한다. 이 선택은 source 간 starvation과 ready path에 영향을 준다. Arbiter가 load를 실제로 받을 수 있을 때만 step을 막아야 한다면 readiness와 buffering contract를 다시 설계한다.

## 5. 독립 `if`의 Last Assignment Wins

다음 코드는 두 update가 병렬로 적용되는 것처럼 보이지만 그렇지 않다.

```systemverilog
always_ff @(posedge clk) begin
  if (clear)
    value_q <= '0;
  if (load)
    value_q <= load_data;
end
```

`clear && load`이면 같은 procedural block의 마지막 nonblocking assignment인 load가 최종값을 결정한다. 즉 이 코드는 `load > clear` priority다. 같은 register를 갱신하는 event는 `if/else if`, 명시적 next-state 계산 또는 완전한 combination table로 의도를 드러낸다.

서로 다른 register에 대한 두 event는 같은 edge에 merge될 수 있다. 그러나 한 event가 다른 register의 old value와 new value 중 무엇을 읽는지는 NBA semantics와 architecture contract를 함께 확인해야 한다.

## 6. Held-Level과 Back-to-Back Event

Ready/valid에서는 `valid && ready`인 **각 cycle**이 한 transfer다. Source가 한 논리 사건을 level high로 유지하면서 destination ready가 계속 high이면 매 cycle 새 acceptance가 된다.

따라서 interface는 다음 중 하나여야 한다.

- 매 cycle의 high를 별도 event로 정의한다.
- Source가 첫 acceptance 다음 cycle에 valid를 낮추거나 새 payload를 제시한다.
- Edge detector로 one-shot event를 만든다.
- Sticky pending/acknowledge 또는 queue로 사건을 보존한다.

Pulse, level, re-arm과 sticky pending 구조는 [Pulse, Level, and Event](pulse_level_event.md)에서 다룬다.

Back-to-back transfer는 valid가 내려가지 않아도 payload가 매 accepted edge마다 바뀔 수 있다. “valid가 계속 high”와 “같은 request를 held”를 waveform만 보고 혼동하지 말고 source contract와 transaction identifier를 사용한다.

## 7. Cycle Audit

위 generic block에서 source가 acceptance까지 request를 유지한다고 가정한다.

| Edge | `flush` | `load_valid` | `step_req` | Accepted event | Edge 이후 값 |
|---|---:|---:|---:|---|---|
| E0 | 0 | 0 | 1 | step | old + 1 |
| E1 | 0 | 1 | 1 | load만 | `load_data` |
| E2 | 1 | 1 | 1 | 없음 | 0 |
| E3 | 0 | 1 | 1 | load만 | held load payload |
| E4 | 0 | 0 | 1 | step | loaded value + 1 |

E2의 load와 step은 request였지만 accepted event가 아니다. E3에서 source가 load를 유지했기 때문에 load가 처음 accepted된다. 만약 input이 one-cycle pulse라서 E2 뒤 사라진다면 request는 유실된다. 그 interface에는 queue, pending bit 또는 explicit reject/error가 필요하다.

검토 표에는 single event뿐 아니라 모든 pair, triple overlap과 back-to-back sequence를 넣는다. Event가 N개라고 모든 `2^N` 조합을 무조건 수작업으로 나열할 필요는 없지만, 같은 state를 쓰거나 readiness에 영향을 주는 조합은 반드시 분류한다.

## 8. Synthesis, STA와 PPA 관점

### Synthesis

긴 `else if` chain은 priority selection으로 mapping될 수 있다. Mutually exclusive condition이라면 tool이 단순화할 수도 있지만, exclusivity를 보장하는 constraints와 assertions가 정확해야 한다. 자세한 hardware mapping은 [Priority and MUX](../01_fundamentals/priority_and_mux.md)를 참고한다.

### Timing

Priority가 깊을수록 뒤 조건은 앞 조건이 거짓이라는 dependency를 통과할 수 있다. Ready를 서로의 valid/ready에 연결하면 block 경계를 가로지르는 late-control path나 combinational loop가 생길 수 있다. Queue를 추가하면 path를 끊을 수 있지만 storage, latency와 power가 늘어난다.

### Power와 area

Priority/merge decode, reject/error status와 queue는 서로 다른 비용을 가진다. Silent drop은 logic이 적어 보여도 기능적으로 허용되지 않으면 최적화 후보가 아니다. 먼저 계약을 고정하고 같은 기능의 구현만 비교한다.

## 9. 적용하면 안 되는 패턴

- Mutual exclusivity를 검증하지 않은 채 parallel/one-hot decode로 바꾼다.
- One-cycle request를 ready가 낮은 cycle에 그냥 무시한다.
- `valid`를 transaction count enable로 쓰고 `ready`를 무시한다.
- Simultaneous set/clear 의미를 software가 알아서 피할 것이라고 가정한다.
- Queue depth와 overflow contract 없이 “나중에 처리한다”고 명세한다.
- PPA를 위해 priority를 바꾸면서 functional change로 기록하지 않는다.

## 10. Verification Strategy

### Matrix와 scoreboard

- 각 state에서 event bit-vector와 expected winner/merge/reject를 표로 만든다.
- Request 수가 아니라 acceptance 수를 scoreboard input으로 사용한다.
- Backpressure, held-valid, back-to-back와 payload change를 섞는다.
- 패자 request가 재시도되는지, error가 기록되는지, queue에 저장되는지 확인한다.

### SVA sampling

Clocked assertion은 active edge의 preponed 값으로 antecedent를 평가하고, RTL의 nonblocking assignment 결과는 다음 clock sample에서 관찰한다. 따라서 state update는 일반적으로 `|=>`로 검사한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_no_accept_during_flush:
  assert property (flush |-> !load_accept && !step_accept);

ap_load_excludes_step:
  assert property (load_accept |-> !step_accept);

ap_load_update:
  assert property (load_accept |=>
                   state_q == $past(load_data));

ap_step_update:
  assert property (step_accept |=>
                   state_q == ($past(state_q) + 8'd1));

ap_flush_update:
  assert property (flush |=> state_q == '0);
```

환경이 두 request의 동시 제시를 금지한다면 `assume`을 DUT 내부에 숨기지 말고 interface boundary의 formal environment에 둔다. RTL에서는 가능하면 diagnostic assertion으로 실제 위반도 잡는다.

## 11. Design Review Checklist

- [ ] 같은 state를 바꾸는 모든 event를 식별했는가?
- [ ] 모든 중요한 조합을 priority, merge, reject 또는 queue로 분류했는가?
- [ ] Request와 accepted event가 명명과 accounting에서 분리됐는가?
- [ ] 패자 request의 retry, drop, error 또는 buffering 규칙이 있는가?
- [ ] Reset/flush와 functional event가 겹칠 때 ready/valid 의미가 명확한가?
- [ ] Set/clear 동시 발생의 dominance가 requirement에 있는가?
- [ ] Held-high가 한 event인지 매 cycle event인지 정의했는가?
- [ ] Back-to-back transfer와 same-edge merge를 cycle table로 검토했는가?
- [ ] Independent `if`의 last-assignment priority를 제거하거나 의도적으로 문서화했는가?
- [ ] Assertions가 acceptance와 NBA sampling을 기준으로 작성됐는가?

## 관련 문서

- [Priority and MUX](../01_fundamentals/priority_and_mux.md)
- [FSM Design](fsm_design.md)
- [Pulse, Level, and Event](pulse_level_event.md)
- [Counter Boundary Design](counter_boundary.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
