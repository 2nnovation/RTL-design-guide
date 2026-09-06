# Ignoring Synthesis Result and Fanout

RTL simulation이 통과하고 synthesis summary의 area가 줄었다고 해서 의도한 hardware가 만들어졌다고 결론 내릴 수 없다. 필요한 carry가 이미 잘렸거나 output 연결이 빠져도 tool은 주어진 RTL을 충실하게 최적화할 수 있다. 반대로 논리적으로 작은 shared control 하나가 넓은 physical region을 구동하면 synthesis 단계의 절감이 routing·buffer·clock 비용으로 되돌아올 수 있다.

이 anti-pattern은 **RTL의 구조 가설과 implementation 결과 사이의 feedback을 끊는 것**이다. Report를 읽지 않는 문제와 fanout를 무시하는 문제는 별개가 아니다. 둘 다 “작성한 식”을 “구현된 회로”로 간주할 때 발생한다.

Report의 종류와 읽는 순서는 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md), distribution의 물리적 해석은 [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)를 정본으로 삼는다. 이 문서는 예상과 실제가 어긋났을 때 어떤 가설을 기각하고 무엇을 다시 검증해야 하는지에 집중한다.

## 1. Bad example: 사라진 carry를 area 개선으로 보고한다

다음은 module 내부의 축약 예제다. `a_i`, `b_i`는 unsigned 8비트 입력이고 `sum_q`는 8비트 register다. `rst`, `clear`, `load`는 같은 clock domain의 control이며 우선순위는 **synchronous reset → clear → load → hold**다.

```systemverilog
logic [7:0] sum_q;

always_ff @(posedge clk) begin
    if (rst) begin
        sum_q <= '0;
    end else if (clear) begin
        sum_q <= '0;
    end else if (load) begin
        sum_q <= a_i + b_i;
    end
end

assign sum_o      = sum_q;
assign overflow_o = ({1'b0, sum_q} > 9'd255);
```

Unsigned carry를 보존해야 한다는 specification이라면 이 RTL은 틀렸다. 이미 8비트 register에 저장하면서 버린 bit는 나중에 zero-extension해도 복원되지 않는다. 알려진 0/1 값에서 `sum_q`는 255를 넘을 수 없으므로 `overflow_o`는 항상 0이다. 예를 들어 `255 + 1`을 load하면 `sum_o=0`, `overflow_o=0`이 되어야 한다고 RTL 자체가 기술하고 있다.

합성이 overflow 비교를 constant로 제거해도 synthesis bug가 아니다. Carry가 발생하지 않는 stimulus만 쓰거나 low 8비트만 검사하는 scoreboard라면 simulation도 이 결함을 놓친다. X가 포함된 simulation의 비교 결과와 합성의 constant 처리 전제는 별도 검토하며, X를 유효한 arithmetic 값으로 해석하지 않는다.

### Better pattern: 필요한 정보를 연산 시점부터 보존한다

동일한 입력·control 계약에서 full unsigned sum이 요구된다면 operands를 명시적으로 확장하고 결과를 9비트로 저장한다.

```systemverilog
logic [8:0] sum_ext_q;

always_ff @(posedge clk) begin
    if (rst) begin
        sum_ext_q <= '0;
    end else if (clear) begin
        sum_ext_q <= '0;
    end else if (load) begin
        sum_ext_q <= {1'b0, a_i} + {1'b0, b_i};
    end
end

assign sum_o      = sum_ext_q[7:0];
assign overflow_o = sum_ext_q[8];
```

Reset/clear/load priority와 hold behavior는 그대로다. 여기서 `overflow_o`는 unsigned carry이며 signed overflow와 다르다. Saturation이 요구되면 carry를 노출하는 것만으로 충분하지 않다. Width·signedness·boundary policy는 [Datapath Width and Signedness](../10_datapath/width_signedness.md)와 [Overflow, Saturation, and Rounding](../10_datapath/overflow_saturation_rounding.md)을 참고한다.

Expected structure는 9비트의 관찰 가능한 state와 필요한 carry cone이다. 이것이 특정 종류 FF 9개나 독립된 comparator 한 개를 보장하지는 않는다. Target mapping, packing, output 사용과 다른 최적화가 cell 구성을 바꿀 수 있다. Register bit 의미와 output connectivity를 먼저 확인하고 mapped cell 수를 해석한다.

## 2. Hardware 관점: 무엇이 사라지고 무엇이 남았는가

Review의 첫 질문은 “왜 gate가 줄었는가?”이지 “더 작은 숫자인가?”가 아니다.

| Report/netlist 관찰 | 정당한 설명 후보 | 놓치면 위험한 설명 후보 |
|---|---|---|
| Register/cone 제거 | Compile-time feature off, 사용하지 않는 state | Output 연결 누락, wrong top, valid가 영구 0 |
| Constant comparator | Range상 항상 참/거짓인 조건 | Truncation, unsigned negative test, 잘못된 literal |
| 예상보다 작은 arithmetic | 필요 없는 상위 bit 제거, constant operand | 의도한 carry/sign extension 누락 |
| Memory가 FF/MUX로 구현 | Target이나 port contract에 맞는 fallback | Reset/read/write semantics가 macro inference를 막음 |
| MUX나 enable 증가 | Required hold와 event priority 보존 | 불필요한 clear, 과도한 개별 enable |
| Decode/operator 공유 | Mutually exclusive use의 합법적 공유 | 예상한 local replica가 merge돼 broadcast 발생 |

예를 들어 unsigned로 선언한 값의 `value < 0` 검사는 이름에 `signed_delta`라는 의도가 담겨 있어도 signed 비교가 되지 않는다. 연산자 개수만 세지 말고 elaborated width, extension, truncation 지점과 실제 reachable range를 확인한다.

Yosys는 `opt_expr`, `opt_clean`, `opt_merge` 등으로 constant folding, unused object 제거와 동일 cell 병합을 설명한다. 이는 공개된 한 synthesis flow의 예이며 모든 tool의 pass 순서나 결과를 일반화하는 근거는 아니다. [Yosys optimization passes](https://yosyshq.readthedocs.io/projects/yosys/en/v0.56/using_yosys/synthesis/opt.html)

Unexpected removal을 발견했다고 즉시 `keep`/`dont_touch`로 막지 않는다. 먼저 spec의 관찰 지점, top/parameter/tie-off, RTL 연결과 verification coverage를 확인한다. 보존 속성은 필요한 기능이 올바르게 구현되었다는 증거가 아니며 다른 합법적 최적화를 제한할 수 있다. 자세한 분류는 [Constant and Dead Logic](../11_synthesis/constant_dead_logic.md)에 있다.

## 3. Priority·MUX·enable은 같은 숫자로 설명되지 않는다

다음과 같은 review 결론은 불충분하다.

- “`case`로 바꿨으니 balanced MUX다.”
- “Operator가 하나니 area와 timing이 모두 좋다.”
- “Register 값이 hold하니 clock power도 줄었다.”
- “Net fanout가 낮아졌으니 distribution 문제가 해결됐다.”

Source order가 기능적 priority라면 동시에 요청된 입력 중 누가 이기는지 보존해야 한다. One-hot/exclusivity를 실제로 보장하지 않고 priority를 parallel selection으로 바꾸면 illegal/overlap behavior가 달라질 수 있다. 실제 path에서는 data input이 아니라 늦게 도착한 select가 critical일 수도 있다. [Deep Priority Chain](deep_priority_chain.md)과 [Large Decode Without Timing Review](large_decode_without_timing_review.md)을 참고한다.

Register hold는 feedback MUX, dedicated enable 또는 대상 flow가 허용하는 clock-gating 구조로 mapping될 수 있다. RTL `if (enable)`만으로 ICG가 존재한다고 보고하지 않는다. Yosys의 `clockgate` pass도 같은 clock/enable을 공유하는 eligible FF group을 대상으로 하는 명시적 변환을 설명한다. [Yosys clockgate](https://yosyshq.readthedocs.io/projects/yosys/en/v0.52/cmd/clockgate.html)

Mapped netlist에서는 enable/clear/reset priority, 실제 CE/ICG group, ungated upstream cone을 확인한다. Clock-gating이 있으면 clock tree와 test control, gated region의 reset 동작까지 검토한다. 한 합성 pass의 성공은 DFT·clock/reset signoff 전체를 대체하지 않는다.

## 4. Bad example: shared control의 fanout를 RTL 밖의 문제로 넘긴다

다음은 이미 선언된 input과 payload register를 사용하는 module 내부 fragment다. 모든 signal은 같은 clock domain에 있으며 우선순위는 **synchronous reset → clear → update → hold**다.

```systemverilog
logic update_all;
assign update_all = request_i && (mode_i == 2'b01) && !stall_i;

always_ff @(posedge clk) begin
    if (rst) begin
        payload_a_q <= '0;
        payload_b_q <= '0;
    end else if (clear) begin
        payload_a_q <= '0;
        payload_b_q <= '0;
    end else if (update_all) begin
        payload_a_q <= data_a_i;
        payload_b_q <= data_b_i;
    end
end
```

이 RTL이 항상 잘못된 것은 아니다. 두 payload bank가 넓고 멀리 떨어져 있는데도 “decode 하나”라는 이유로 closure를 선언하는 것이 anti-pattern이다. `update_all`뿐 아니라 `clear`와 `rst`도 많은 endpoint의 next-state selection 또는 control pin에 영향을 줄 수 있다.

```text
request/mode/stall --> shared decode --> distribution root
                                             |
                                +------------+------------+
                                |                         |
                           buffer branch A           buffer branch B
                                |                         |
                         nearby payload bank       distant payload bank
```

Root가 두 buffer만 직접 구동하면 direct fanout는 작다. 그러나 tree 뒤의 leaf load와 긴 branch는 그대로 남는다. 반대로 fanout 1인 net도 먼 macro까지 가는 긴 wire이면 timing을 지배할 수 있다. Fanout count를 capacitance나 delay와 동일시하지 않는다.

### 확인할 증거

- **Topology:** Source pin, direct sinks, buffer 뒤 leaf sinks, branch별 endpoint group
- **Electrical:** Pin/wire capacitance, transition slew, max cap/slew/fanout violation
- **Timing:** Source decode arrival, buffer cell delay, net delay, capture pin과 setup/hold
- **Physical:** Consumer 위치, branch 길이, congestion, available routing layer와 pin access
- **Power:** Decode glitch, data switching, buffer activity, FF/ICG와 clock tree 포함 범위

Clock/reset distribution은 일반 data net과 요구 조건이 다르다. Clock에는 skew·pulse width·CTS 제약이 있고 asynchronous reset에는 recovery/removal과 release coherency가 있다. Fanout를 줄인다는 이유로 raw clock logic이나 독립적인 reset/CDC state replica를 추가하지 않는다.

OpenROAD의 `repair_design`은 fanout뿐 아니라 max slew/capacitance와 long-wire RC를 다룬다. 문서는 placement 기반 parasitic 추정과 routed parasitic의 차이도 명시한다. Buffer가 삽입됐다는 사실은 physical repair의 증거이지 post-route timing 통과의 증거가 아니다. [OpenROAD Gate Resizer](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html)

## 5. Better pattern: feedback을 의사결정의 입력으로 만든다

```text
Spec / configuration / event priority
                  |
                  v
RTL + expected hardware hypothesis
                  |
                  v
Elaboration / synthesis ---- unexpected removal or mapping?
                  |                         |
                  v                         +--> RTL/spec/verification review
Mapped netlist + STA -------- logic depth or late control?
                  |                         |
                  v                         +--> architecture candidate
Place / CTS / route -------- fanout, wire, clock/reset cost?
                  |                         |
                  +-------------------------+--> compare and re-verify
```

### Step 1: 실행 전 가설을 짧게 기록한다

“Area를 개선한다”보다 “사용하지 않는 payload reset을 valid guard로 대체해 reset/control load를 줄인다”처럼 제거할 구조와 남겨야 할 behavior를 적는다. Acceptance, priority, latency, reset, mode와 observability가 기준이다.

Top, filelist, parameter/define, RTL revision, tool/library, constraints, mode/corner와 stage를 같은 run identity로 묶는다. Wrong configuration의 좋은 report는 비교 대상이 아니다.

### Step 2: 기능과 mapping의 이상 징후를 먼저 처리한다

Carry/valid/output이 예상과 다르게 사라졌거나 latch·undriven logic·memory fallback이 생기면 total area보다 먼저 원인을 조사한다. Generic operator 수, sequential bit 수, mapped cell 수, macro 포함 면적을 분리한다. Warning waiver에는 config·원인·evidence·재검토 조건을 남긴다.

### Step 3: 같은 critical cone을 단계별로 추적한다

Synthesis의 논리 구조를 actual STA startpoint/endpoint와 연결하고, post-place/route에서 cell/net delay와 위치를 확인한다. Buffering이나 replication으로 이름이 바뀌면 source RTL signal의 문자열만 검색하지 말고 connectivity와 tool의 mapping 정보를 이용한다.

WNS만 비교하지 않는다. Path group별 coverage, violating endpoint, hold, electrical violation과 unconstrained endpoint를 함께 본다. 한 view에서 path가 사라졌다면 빨라진 것인지 exception/case analysis로 분석에서 제외됐는지 구분한다.

### Step 4: 원인에 맞는 후보를 하나씩 비교한다

기본 순서는 **Remove → Disable → Simplify → Share or Duplicate → Pipeline or MCP → Physical optimization**이다. 단계마다 기능 계약을 먼저 통과시킨다.

| 후보 | 기대 효과 | 되돌아올 수 있는 비용 / 필요한 확인 |
|---|---|---|
| 불필요 state/reset 제거 | FF/control load·switching 감소 | Valid-before-use, reset/test observability |
| Enable/operand isolation | 불필요한 update 또는 cone activity 감소 | CE/MUX/ICG mapping, enable fanout, upstream switching |
| Width/decode 단순화 | Arithmetic/MUX/load 축소 | Range/sign/alias/priority proof |
| Shared logic | Duplicate gate/operator 감소 | Select depth, source load, broadcast route |
| Local combinational duplication | Consumer 근처 control 생성 가능 | 동일 식 재병합, raw input distribution, duplicate power |
| Registered replica/pipeline | Path 분리와 select arrival 개선 가능 | State/latency, data-tag alignment, FF/clock/reset 비용 |
| Buffering/upsizing/placement | Electrical load와 route 개선 가능 | Area/leakage, source load, hold, 다른 region congestion |

같은 식을 두 번 쓰거나 hierarchy를 나눈 것만으로 local replica를 얻었다고 보고하지 않는다. Actual replica와 placement가 필요하다. Register를 복제하면 combinational duplication과 달리 state·reset·enable·equivalence 계약이 생긴다. MCP는 물리적 회로 수리가 아니며 실제 multi-cycle launch/capture 동작이 있는 경우에만 후보가 된다.

### Step 5: 채택 근거와 남은 불확실성을 남긴다

A/B 비교에는 같은 mode/corner·activity·constraint coverage와 physical stage를 사용한다. Cell area와 core utilization, mapped delay와 extracted delay, vectorless estimate와 workload-based power를 섞지 않는다. 작은 개선은 placement seed/flow 변동과 분리해 재현성을 확인한다.

구조 가설, 관찰된 mapping, functional/equivalence 결과, PPA 변화와 owner를 [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)에 연결한다. Physical closure의 반복 방법은 [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md)에 있다.

## 6. 허용 가능한 예외와 경계

- **합법적인 제거:** Unsupported compile-time feature나 관찰 불가능한 state 제거는 바람직하다. 지원되는 configuration의 기능까지 사라지지 않았는지 별도로 확인한다.
- **의도한 high fanout:** Clock/reset 또는 broadcast control은 높은 fanout가 필요할 수 있다. Target methodology와 implementation evidence로 수용하며 임의의 보편적 fanout 상한을 만들지 않는다.
- **Tool-managed optimization:** 자동 sharing/replication을 활용할 수 있다. 그렇더라도 expected structure와 post-route 결과를 확인할 책임은 남는다.
- **Macro/blackbox/IP:** 내부 cell 수가 보이지 않으면 interface timing model, library view, integration coverage와 owner를 확인한다. “내부 report 없음”을 “비용 없음”으로 해석하지 않는다.
- **초기 architecture 탐색:** 모든 후보에 full P&R이 필요하지 않을 수 있다. Pre-route estimate임을 표시하고 physical risk가 큰 최종 후보는 뒤 단계에서 검증한다.

## 7. Verification과 evidence

Arithmetic 예제는 unsigned 8비트 입력 쌍 전체를 수학적 합과 비교할 수 있다. Reference는 DUT처럼 먼저 8비트로 잘라서는 안 된다. `0+0`, `255+0`, `255+1`, `255+255`를 포함하고 reset/clear/load collision 및 hold를 따로 검사한다. Bad RTL이 carry case에서 실패함을 확인해야 checker의 검출 능력을 보여준다.

Fanout는 Boolean truth table로 검증할 수 없다. Combinational local decode 후보는 원래 decode와 기능적으로 비교하고, 실제 replica 존재·배치·route·cap/slew는 implementation report로 확인한다. Registered 후보는 cycle/transaction equivalence까지 필요하다.

RTL simulation, assertion, equivalence는 구현 timing·power signoff가 아니다. 반대로 clean STA가 arithmetic specification correctness를 증명하지 않는다. 각 evidence가 보장하는 범위를 분리하고 미실행·추정·측정 결과를 구분한다.

## 8. Design Review Checklist

- [ ] Run의 top/configuration/RTL/library/constraint/stage가 비교 기준과 일치하는가?
- [ ] 예상 state bit·operator·MUX·memory 구조와 실제 mapping 차이를 설명할 수 있는가?
- [ ] Unexpected removal을 기능 누락이나 width/signedness 오류와 구분했는가?
- [ ] Reset/clear/load priority와 overlap behavior를 유지했는가?
- [ ] Constant tie-off와 runtime mode/STA case analysis를 혼동하지 않았는가?
- [ ] Hold를 CE/ICG 존재나 upstream power 감소로 단정하지 않는가?
- [ ] Critical cone에서 data와 late select/control path를 모두 확인했는가?
- [ ] Direct fanout, leaf load, capacitance, slew와 긴 wire를 구분했는가?
- [ ] Clock/reset/CDC control에 data-net repair를 무분별하게 적용하지 않는가?
- [ ] Shared/local 구조의 실제 merge·replica·placement를 확인했는가?
- [ ] 변경 후 setup/hold·electrical·mode/corner·activity coverage를 다시 봤는가?
- [ ] Pre-route 기대와 post-route 결과의 차이가 다음 RTL 판단과 owner에게 전달됐는가?

## 관련 문서

- [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md): report 해석과 run provenance
- [RTL to Hardware Mapping](../11_synthesis/rtl_to_hardware_mapping.md): elaboration과 실제 hardware 구조
- [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md): hold·priority와 enable mapping
- [Fanout and Locality](../12_physical_aware/fanout_and_locality.md): distribution과 replication의 물리적 증거
- [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md): 단계별 PPA 비교와 feedback
- [Assumption Hidden Only in SDC](assumption_hidden_only_in_sdc.md): report가 전제하는 functional contract

## 참고 자료

- [Yosys 0.56, Optimization passes](https://yosyshq.readthedocs.io/projects/yosys/en/v0.56/using_yosys/synthesis/opt.html): constant·unused logic·merge의 공개 구현 예
- [Yosys 0.52, clockgate](https://yosyshq.readthedocs.io/projects/yosys/en/v0.52/cmd/clockgate.html): eligible clock/enable group의 ICG 변환 예
- [OpenROAD, Gate Resizer](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html): electrical repair와 placement/routing parasitic의 구분
