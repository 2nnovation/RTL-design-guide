# Reset Everything

모든 register에 같은 reset을 붙이면 초기 waveform은 깨끗해 보이고 code review도 단순해 보인다. 그러나 reset은 무료 초기값 표기가 아니다. Resettable sequential cell 또는 data-path MUX, reset distribution network, recovery/removal 또는 synchronous reset timing, DFT와 clock-gating interaction을 함께 만든다.

반대 극단도 안전하지 않다. Resetless state의 오래된 값이나 simulation `X`가 observable control 또는 interface로 새면 functional bug가 된다. 목표는 reset을 무조건 제거하는 것이 아니라 **state마다 reset 후 관찰 가능한 계약을 정의하는 것**이다.

Reset architecture의 정본은 [Reset Architecture Overview](../07_reset/overview.md)다. 이 문서는 review에서 “모든 것을 reset”하는 anti-pattern을 발견하고, state inventory·대안·예외·증거를 판단하는 데 집중한다.

## 1. 문제: 선언된 state를 일괄 reset

다음 pipeline은 valid와 payload를 모두 reset한다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        valid_q   <= 1'b0;
        payload_q <= '0;
    end else begin
        valid_q <= in_valid;
        if (in_valid)
            payload_q <= in_payload;
    end
end
```

Interface contract가 `valid_q=0`일 때 `payload_q`를 관찰하지 않는다면 payload의 reset value는 기능적으로 필요하지 않을 수 있다. 그런데도 wide payload, pipeline stage와 register array 전체에 reset을 복사하면 reset load가 빠르게 커진다.

더 위험한 동기는 “simulation의 X를 없애기 위해서”다. X가 valid 없이 읽히는 bug를 reset으로 가리면 실제 observation contract가 검증되지 않는다. Reset을 넣어 waveform을 조용하게 만드는 것과 architecture가 초기값을 요구하는 것은 다른 판단이다.

## 2. State inventory로 reset 필요성을 분류한다

각 state를 이름이 아니라 역할과 observer로 분류한다.

| State 종류 | 일반적인 reset 질문 | 예 |
|---|---|---|
| Control/phase | Reset 직후 side effect를 막기 위해 known state가 필요한가? | FSM state, busy, pending |
| Valid/occupancy | Payload가 관찰되지 않음을 보장하는 root인가? | valid, FIFO pointers/count |
| Architecturally observable | Software/protocol/test가 reset value를 요구하는가? | status, interrupt mask, error latch |
| Valid-guarded datapath | Valid가 0일 때 모든 observer가 무시하는가? | payload pipeline, intermediate result |
| Derived/cache state | Authoritative source에서 사용 전에 재생성되는가? | cached compare, precomputed field |
| Safety/test state | 표준·test architecture가 초기값이나 controllability를 요구하는가? | safety monitor, scan-visible control |

Reset을 제거하기 쉬운 후보는 보통 **valid-guarded payload**다. 반면 valid, protocol phase, externally visible state는 known reset value가 필요한 경우가 많다. 같은 `struct` 안에 있다는 이유로 같은 정책을 강제하지 않는다.

State ownership과 lifetime을 찾는 방법은 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md), reset 비용 분석은 [Reset Area Cost](../05_area/reset_area_cost.md)을 참고한다.

## 3. Resetless payload의 정확한 계약

Resetless는 “초기값이 우연히 무엇이든 괜찮다”는 뜻이 아니다. 다음 조건을 모두 만족해야 한다.

1. Reset 후 `valid=0` 또는 동등한 control state가 확실히 성립한다.
2. Payload를 읽는 **모든** functional observer가 valid를 확인한다.
3. Valid가 1이 되는 edge에는 같은 transaction의 payload가 이미 capture되어 있다.
4. Reset, flush, clock stop과 mode transition이 stale valid를 다시 살리지 않는다.
5. Debug, assertion, ECC/parity, compare와 CDC path도 hidden observer로 포함한다.

```text
reset asserted       reset released           first accepted input
valid = 0            valid remains 0           payload captured, valid = 1
payload = X/stale    payload ignored           payload now observable
```

Payload가 `X`인 것은 이 window에서 허용될 수 있지만, 어떤 side effect도 그 값에 의존해서는 안 된다. 이 proof burden 때문에 control과 valid는 선택적으로 reset하고 datapath는 resetless로 두는 구조가 필요하다.

## 4. 권장 패턴: valid와 payload를 분리한다

다음 예는 backpressure가 없는 1-cycle pipeline이다. Priority는 `reset > normal valid update`이며, reset은 outstanding transaction을 취소한다.

```systemverilog
module valid_guarded_stage #(
    parameter int unsigned DATA_W = 32
) (
    input  logic              clk,
    input  logic              rst_n,
    input  logic              in_valid,
    input  logic [DATA_W-1:0] in_data,
    output logic              out_valid,
    output logic [DATA_W-1:0] out_data
);

    logic              valid_q;
    logic [DATA_W-1:0] data_q;

    always_ff @(posedge clk) begin
        if (in_valid)
            data_q <= in_data;
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            valid_q <= 1'b0;
        else
            valid_q <= in_valid;
    end

    assign out_valid = valid_q;
    assign out_data  = data_q;

endmodule
```

이 예에서 consumer는 `out_valid=1`일 때만 `out_data`를 사용해야 한다. `out_data` 자체가 top-level port라는 이유만으로 관찰 가능성이 사라지지는 않는다. Interface specification, assertions와 모든 downstream logic이 guard contract를 지켜야 한다.

Backpressure, multi-stage pipeline, flush 또는 simultaneous reset/accept가 있으면 valid 이동과 payload capture가 더 복잡해진다. 단순 예제를 그대로 확장하지 말고 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)와 [Reset and Mode Transition Verification](../13_verification/reset_mode_transition_verification.md)의 acceptance/commit contract를 적용한다.

## 5. 실제 구현 비용

### 5.1 Sequential cell과 data MUX

Target library에 원하는 reset polarity/value/enable 조합의 sequential cell이 있으면 resettable FF로 mapping될 수 있다. 없으면 inverter, data MUX 또는 다른 cell 조합이 추가될 수 있다. FPGA에서는 reset 사용이 register packing, shift-register/LUT RAM/DSP/memory inference와 전용 control set에 영향을 줄 수 있다. 정확한 결과는 target library/device와 synthesis setting에 따라 report로 확인한다.

### 5.2 Reset fanout와 routing

수천 개 payload bit를 한 reset net에 연결하면 reset tree buffer, routing resource와 pin capacitance가 증가한다. Reset net이 data/clock routing과 경쟁하거나 congestion을 만들 수 있으며, source와 branch의 slew/capacitance 조건도 확인해야 한다. Synthesis cell area가 같아 보여도 placed design의 footprint와 timing은 달라질 수 있다.

### 5.3 Timing

- Synchronous reset은 data input의 priority MUX와 setup path에 들어갈 수 있다.
- Asynchronous reset assertion은 clock 없이 적용되지만 deassertion에는 recovery/removal와 RDC 검토가 필요하다.
- Resettable cell 선택이 clock-to-Q, setup, area와 leakage 특성을 바꿀 수 있다.
- High-fanout reset control과 local decode가 functional timing 또는 physical congestion에 영향을 줄 수 있다.

### 5.4 Clock gating과 wake-up

Synchronous reset state가 gated clock 아래에 있으면 clock이 꺼진 동안 초기화되지 않는다. Asynchronous reset을 사용해도 release와 first active edge, local reset-done가 정의되어야 한다. Clock gate를 열기 위한 state까지 gated domain에 두면 reset/wake-up deadlock이 생길 수 있다. 정본은 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md)이다.

## 6. 위험한 수정과 실패 모드

### Valid만 reset했지만 hidden observer가 payload를 읽음

다음과 같은 경로는 흔히 빠뜨린다.

- `out_valid`와 무관하게 계산되는 parity/error compare
- Payload 일부로 생성되는 interrupt 또는 address side effect
- Assertion이나 coverage가 unguarded payload를 사용
- Debug/trace logic이 stale value를 externally expose
- CDC source register가 valid와 별도로 destination에서 관찰됨

Payload reset을 제거하기 전에 fanout cone과 interface를 구조적으로 확인해야 한다.

### Control reset까지 제거함

Reset area를 줄이겠다는 이유로 valid, FSM, write-enable 또는 pointer를 resetless로 만들면 random/stale side effect가 생길 수 있다. Resetless datapath 최적화를 arbitrary control state에 일반화하지 않는다.

### Reset으로 X를 덮음

Simulation X가 나타났을 때 먼저 물어야 할 질문은 “왜 reset하지 않았나?”가 아니라 “valid 이전에 누가 읽었나?”다. X-propagation은 2-state/formal 초기화 가정과 다르게 동작할 수 있으므로 methodology별 semantics를 기록한다. 모든 payload를 reset해 X를 제거하면 missing guard를 찾을 기회를 잃을 수 있다.

## 7. Reset이 정당한 예외

다음에는 넓은 state라도 reset이 필요할 수 있다.

- Interface나 software-visible specification이 reset value를 요구한다.
- Safety goal이 deterministic initialization 또는 fault containment를 요구한다.
- Protocol state가 reset 직후 ready/idle/error behavior를 결정한다.
- DFT/BIST/scan architecture가 controllability·observability 또는 test sequence를 요구한다.
- ECC/parity state가 data보다 먼저 검사되며 unknown syndrome을 허용할 수 없다.
- Valid guard 없이 외부 pin, memory command나 irreversible side effect를 구동한다.
- Retention/power-domain sequence가 restore 실패 시 명시적 initialization을 요구한다.

예외의 증명 책임은 “안전해 보여서”가 아니라 requirement ID, observer, reset value, assertion/test와 implementation cost를 연결하는 것이다. Safety나 test requirement는 functional simulation만으로 대체할 수 없다.

## 8. Verification과 evidence

### Contract assertions

환경과 interface에 맞게 다음 property를 구체화한다.

```systemverilog
// Valid가 없을 때 consumer side effect가 없어야 한다.
ap_no_commit_without_valid:
    assert property (@(posedge clk) disable iff (!rst_n)
        commit |-> out_valid);

// Valid인 transaction의 payload에는 unknown이 없어야 한다.
ap_known_when_valid:
    assert property (@(posedge clk) disable iff (!rst_n)
        out_valid |-> !$isunknown(out_data));
```

`commit`은 실제 irreversible observation을 대표해야 한다. 단순히 동일한 valid를 다시 확인하는 tautology가 되지 않도록 consumer boundary에서 검사한다.

### Reset·mode corner cases

- Reset assertion 중 input valid와 commit
- Reset release 직후 첫 accepted transaction
- Pipeline이 찬 상태의 reset/flush
- Clock off 중 reset과 wake-up
- Independent reset domain의 one-sided reset과 stale payload
- Back-to-back reset, short reset pulse와 release latency
- Reset 후 payload가 임의값인 symbolic/formal initial state

Corner-case 구성은 [Corner-Case Matrix](../13_verification/corner_case_matrix.md)를 참고한다.

### Implementation evidence

- State inventory: bit 수, role, observer, reset value와 requirement 근거
- Synthesis: resettable/non-resettable sequential bit와 inferred memory/SRL/DSP 변화
- STA/RDC: synchronous reset path, recovery/removal, reset-domain crossing coverage
- Physical: reset fanout, buffer/tree, capacitance, congestion과 timing
- Power/area: 같은 library·corner·physical stage의 before/after
- Equivalence/formal: reset 초기 상태와 unobservable payload modeling이 architecture contract와 일치하는지

Tool이 resetless payload를 arbitrary initial state로 보는지, 2-state zero로 보는지, equivalence가 initial state를 어떻게 대응시키는지는 flow마다 다르다. Proof가 pass했다는 결과와 initial-state model의 타당성을 분리해 기록한다.

## 9. Design Review Checklist

- [ ] 모든 state가 control/valid/observable/payload/derived/safety-test로 분류됐는가?
- [ ] 각 reset value에 requirement 또는 observer 근거가 있는가?
- [ ] Resetless payload의 모든 observer가 valid로 guard되는가?
- [ ] Valid와 payload가 같은 transaction/cycle로 정렬되는가?
- [ ] Reset·flush·mode transition이 stale valid를 살리지 않는가?
- [ ] Debug, parity/ECC, assertion, CDC와 test path를 hidden observer로 확인했는가?
- [ ] Simulation X를 조용하게 만들기 위한 reset이 아닌가?
- [ ] Resettable cell/MUX와 memory·SRL·DSP inference 영향을 report로 확인했는가?
- [ ] Reset fanout, tree, routing, recovery/removal와 RDC를 검토했는가?
- [ ] Gated clock 아래 synchronous reset과 first active edge가 정의됐는가?
- [ ] Safety/protocol/test 예외의 requirement와 verification owner가 있는가?
- [ ] Resetless initial-state model을 simulation/formal/equivalence에서 일관되게 다뤘는가?

## 관련 문서

- [Reset Architecture Overview](../07_reset/overview.md): reset requirement, state inventory와 domain architecture
- [Resetless Datapath](../07_reset/resetless_datapath.md): valid-guarded payload의 상세 contract
- [Reset Deassertion and RDC](../07_reset/reset_deassertion.md): controlled release와 recovery/removal
- [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md): clock-off reset과 wake-up sequence
- [Reset Area Cost](../05_area/reset_area_cost.md): cell, routing, memory mapping과 PPA
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md): state role, lifetime와 observer
- [Reset and Mode Transition Verification](../13_verification/reset_mode_transition_verification.md): drain/abort/preserve와 epoch 검증

## 참고 자료

- [AMD, When and Where to Use a Reset](https://docs.amd.com/r/2024.2-English/ug949-vivado-design-methodology/When-and-Where-to-Use-a-Reset?contentId=SpOcbybsGLfLD7LRe~RsJg): control과 datapath reset을 구분하고 reset 사용량을 제한하는 FPGA 지침
- [AMD, Resets](https://docs.amd.com/r/2024.2-English/ug949-vivado-design-methodology/Resets): reset이 FPGA register와 memory/resource inference에 미치는 target-specific 영향
- [Altera, AN 917: Reset Design Techniques for Hyperflex Architecture FPGAs](https://docs.altera.com/r/docs/683539/current): reset requirement와 routing을 포함한 target-specific FPGA reset 방법론
